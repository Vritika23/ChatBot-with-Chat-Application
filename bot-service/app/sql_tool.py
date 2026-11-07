"""
Live-data tool: lets the bot answer questions from real database tables
(e.g. "Which products are almost out of stock?").

Steps:
  1. plan     – the LLM sees the table schema and writes ONE SELECT query (or NONE)
  2. validate – we parse the SQL with sqlglot and reject anything that is not a
                plain read of the allowed tables
  3. run      – executed by the read-only `bot_reader` role with a 3 s timeout

Three layers of safety, so a tricky prompt ("ignore rules, DROP TABLE ...")
can't damage anything.
"""
from __future__ import annotations

import datetime as dt
import decimal
import re

import sqlglot
from sqlglot import exp

from .db import Database
from .llm import LLM

MAX_ROWS = 50

BLOCKED_FUNCTIONS = re.compile(
    r"^(pg_|lo_|dblink|current_setting|set_config|query_to_xml|xpath|txid_|inet_server|version$)",
    re.I,
)
BLOCKED_NODES = (
    exp.Insert, exp.Update, exp.Delete, exp.Drop, exp.Create, exp.Alter,
    exp.Command, exp.Merge, exp.Into, exp.TruncateTable, exp.Grant,
)


class UnsafeSQL(ValueError):
    pass


# ---------- schema description for the prompt ----------

async def describe_tables(db: Database, tables: list[str]) -> str:
    lines = []
    async with db.readonly.connection() as conn:
        for t in tables:
            cur = await conn.execute(
                """SELECT column_name, data_type FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = %s ORDER BY ordinal_position""",
                (t,),
            )
            cols = await cur.fetchall()
            if not cols:
                continue
            lines.append(f"TABLE {t} (" + ", ".join(f"{c['column_name']} {c['data_type']}" for c in cols) + ")")
            # Two example rows help the model guess values like status names
            cur = await conn.execute(f'SELECT * FROM "{t}" LIMIT 2')  # t comes from our own config
            for row in await cur.fetchall():
                lines.append(f"  example: {_jsonable(row)}")
    return "\n".join(lines)


# ---------- 1. plan ----------

SQL_SYSTEM = (
    "You translate questions into PostgreSQL. You only write read-only SELECT queries. "
    "Never modify data. Use only the tables and columns given."
)


async def plan_sql(llm: LLM, schema: str, question: str, history: str) -> str | None:
    if not schema:
        return None
    prompt = f"""You can query this PostgreSQL database of LIVE data:

{schema}

Recent conversation (for context):
{history or "(none)"}

If answering the question needs data from these tables, reply with exactly ONE
PostgreSQL SELECT query and nothing else. Use ILIKE for text matching.
If the question does not need these tables, reply with the single word NONE.

QUESTION: {question}"""
    raw = (await llm.generate(prompt, system=SQL_SYSTEM)).strip()
    raw = re.sub(r"^```(?:sql)?\s*|\s*```$", "", raw, flags=re.I).strip().rstrip(";").strip()
    if not raw or raw.upper().startswith("NONE"):
        return None
    return raw


# ---------- 2. validate ----------

def validate_sql(sql: str, allowed_tables: list[str]) -> str:
    """Returns a safe, normalised query with a LIMIT, or raises UnsafeSQL."""
    try:
        statements = [s for s in sqlglot.parse(sql, read="postgres") if s is not None]
    except sqlglot.errors.ParseError as e:
        raise UnsafeSQL(f"Could not parse SQL: {e}") from e
    if len(statements) != 1:
        raise UnsafeSQL("Exactly one statement is allowed")
    stmt = statements[0]

    if not isinstance(stmt, exp.Query):
        raise UnsafeSQL("Only SELECT queries are allowed")
    for node_type in BLOCKED_NODES:
        if stmt.find(node_type):
            raise UnsafeSQL(f"{node_type.__name__} is not allowed")

    cte_names = {cte.alias_or_name.lower() for cte in stmt.find_all(exp.CTE)}
    allowed = {t.lower() for t in allowed_tables} | cte_names
    for table in stmt.find_all(exp.Table):
        if table.db and table.db.lower() != "public":
            raise UnsafeSQL(f"Schema {table.db} is not allowed")
        if table.name.lower() not in allowed:
            raise UnsafeSQL(f"Table {table.name} is not allowed")

    for func in stmt.find_all(exp.Func):
        name = func.name if isinstance(func, exp.Anonymous) else func.sql_name()
        if BLOCKED_FUNCTIONS.match(name or ""):
            raise UnsafeSQL(f"Function {name} is not allowed")

    if isinstance(stmt, exp.Select):
        limit = stmt.args.get("limit")
        if limit is None:
            stmt = stmt.limit(MAX_ROWS)
        return stmt.sql(dialect="postgres")
    # UNION etc.: wrap it so we can still add a limit
    return f"SELECT * FROM ({stmt.sql(dialect='postgres')}) AS q LIMIT {MAX_ROWS}"


# ---------- 3. run ----------

async def run_sql(db: Database, sql: str) -> dict:
    async with db.readonly.connection() as conn:
        cur = await conn.execute(sql)
        rows = await cur.fetchmany(MAX_ROWS)
        columns = [d.name for d in cur.description] if cur.description else []
    return {"columns": columns, "rows": [_jsonable(r) for r in rows]}


def _jsonable(row: dict) -> dict:
    out = {}
    for k, v in row.items():
        if isinstance(v, decimal.Decimal):
            v = float(v)
        elif isinstance(v, (dt.date, dt.datetime)):
            v = v.isoformat()
        out[k] = v
    return out
