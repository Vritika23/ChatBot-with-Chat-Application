from pgvector.psycopg import register_vector_async
from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .config import get_settings


async def _configure_main(conn: AsyncConnection) -> None:
    await conn.set_autocommit(True)    # each statement commits on its own
    await register_vector_async(conn)  # lets us pass Python lists as `vector`


async def _configure_readonly(conn: AsyncConnection) -> None:
    # Belt and braces: the role is already read-only in Postgres,
    # and we also mark every connection read-only here (each query then runs
    # inside "BEGIN READ ONLY", rolled back when the connection is returned).
    await conn.set_read_only(True)


class Database:
    """Two connection pools: a normal one, and a read-only one for LLM-written SQL."""

    def __init__(self) -> None:
        s = get_settings()
        self.main = AsyncConnectionPool(
            s.database_url, min_size=1, max_size=10, open=False,
            configure=_configure_main, kwargs={"row_factory": dict_row},
        )
        self.readonly = AsyncConnectionPool(
            s.readonly_database_url, min_size=1, max_size=4, open=False,
            configure=_configure_readonly, kwargs={"row_factory": dict_row},
        )

    async def open(self) -> None:
        await self.main.open(wait=True)
        await self.readonly.open(wait=True)

    async def close(self) -> None:
        await self.main.close()
        await self.readonly.close()

    async def recent_messages(self, chat_id: str, exclude_id: str, limit: int) -> list[dict]:
        """Last few messages of a chat (oldest first) — gives the bot memory."""
        async with self.main.connection() as conn:
            cur = await conn.execute(
                """SELECT sender_id, text FROM messages
                    WHERE chat_id = %s AND id <> %s AND text <> ''
                    ORDER BY created_at DESC LIMIT %s""",
                (chat_id, exclude_id, limit),
            )
            rows = await cur.fetchall()
        return list(reversed(rows))
