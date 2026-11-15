"""
Tests for bot-service. Uses the FakeLLM (no API key, no internet) and no Kafka,
but a REAL Postgres with db/01-schema.sql + db/02-readonly-role.sh loaded.

    LLM_PROVIDER=fake KAFKA_ENABLED=false pytest -q
"""
import io
import os
import uuid

os.environ.setdefault("LLM_PROVIDER", "fake")
os.environ.setdefault("KAFKA_ENABLED", "false")
# FakeLLM uses crude bag-of-words vectors, so similarity scores are lower than real embeddings
os.environ.setdefault("MIN_SIMILARITY", "0.15")

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.kafka_worker import BotWorker, questions_by_chat
from app.rag import chunk_pages
from app.sql_tool import UnsafeSQL, validate_sql

ALLOWED = ["products", "orders"]
USER = f"test-{uuid.uuid4().hex[:8]}"


# ---------- SQL safety ----------

@pytest.mark.parametrize("sql", [
    "SELECT name, stock FROM products WHERE stock < 10",
    "SELECT p.name, count(o.id) FROM products p JOIN orders o ON o.product_id = p.id GROUP BY p.name",
    "WITH low AS (SELECT * FROM products WHERE stock < 5) SELECT name FROM low",
    "SELECT name FROM products UNION SELECT customer_name FROM orders",
])
def test_safe_sql_is_allowed_and_limited(sql):
    out = validate_sql(sql, ALLOWED)
    assert "LIMIT" in out.upper()


@pytest.mark.parametrize("sql", [
    "DROP TABLE products",
    "DELETE FROM orders",
    "UPDATE products SET stock = 0",
    "SELECT * FROM users",                       # not an allowed table
    "SELECT * FROM pg_catalog.pg_user",
    "SELECT pg_sleep(10)",
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT * FROM products; DROP TABLE orders",  # two statements
    "SELECT * INTO stolen FROM products",
    "WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x",
    "COPY products TO '/tmp/x'",
])
def test_unsafe_sql_is_blocked(sql):
    with pytest.raises(UnsafeSQL):
        validate_sql(sql, ALLOWED)


def test_existing_limit_is_kept():
    assert validate_sql("SELECT name FROM products LIMIT 3", ALLOWED).upper().endswith("LIMIT 3")


# ---------- chunking ----------

def test_chunks_respect_size_and_overlap():
    text = " ".join(f"Sentence number {i} talks about topic {i % 7}." for i in range(200))
    chunks = chunk_pages([(1, text)], size=300, overlap=60)
    assert len(chunks) > 5
    assert all(len(c) <= 300 for _, c in chunks)
    # overlap: the start of chunk 2 appeared at the end of chunk 1
    assert chunks[1][1][:20] in chunks[0][1]


# ---------- Kafka filtering ----------

def test_only_messages_to_the_bot_are_answered():
    events = [
        {"toBot": True, "message": {"id": "1", "chatId": "a", "senderId": "u1", "text": "hi"}},
        {"toBot": False, "message": {"id": "2", "chatId": "b", "senderId": "u1", "text": "hi bob"}},
        {"toBot": True, "message": {"id": "3", "chatId": "a", "senderId": "chatbot", "text": "my own reply"}},
        {"toBot": True, "message": {"id": "4", "chatId": "a", "senderId": "u1", "text": "second"}},
    ]
    grouped = questions_by_chat(events, "chatbot")
    assert list(grouped) == ["a"]
    assert [m["id"] for m in grouped["a"]] == ["1", "4"]  # order kept


# ---------- API + RAG + live data (needs Postgres) ----------

@pytest.fixture(scope="module")
def client():
    s = get_settings()
    with psycopg.connect(s.database_url, autocommit=True) as conn:
        conn.execute("INSERT INTO users (id, display_name) VALUES (%s, 'Tester') ON CONFLICT DO NOTHING", (USER,))
    from app.main import app
    with TestClient(app) as c:
        yield c
    with psycopg.connect(s.database_url, autocommit=True) as conn:
        conn.execute("DELETE FROM users WHERE id = %s", (USER,))


H = {"X-User-Id": USER}

NOTES = b"""Kafka notes.

A consumer group lets many consumers share the partitions of a topic. Each partition is read by exactly one consumer in the group.

Retention policy: Kafka keeps messages for seven days by default, even after they are consumed.

Unrelated: the college canteen serves masala dosa on Fridays."""


def test_upload_list_ask_delete_document(client):
    r = client.post("/documents", headers=H, files={"file": ("kafka-notes.txt", io.BytesIO(NOTES), "text/plain")})
    assert r.status_code == 200, r.text
    doc = r.json()
    assert doc["numChunks"] >= 1

    assert [d["id"] for d in client.get("/documents", headers=H).json()] == [doc["id"]]

    r = client.post("/ask", headers=H, json={"question": "How long does Kafka retention keep messages?"})
    body = r.json()
    assert body["meta"]["sources"], "expected the uploaded notes to be retrieved"
    assert body["meta"]["sources"][0]["filename"] == "kafka-notes.txt"
    assert "[Source 1]" in body["text"]

    # another user must NOT see these documents
    other = client.post("/ask", headers={"X-User-Id": "someone-else"}, json={"question": "Kafka retention?"})
    assert other.json()["meta"]["sources"] == []

    assert client.delete(f"/documents/{doc['id']}", headers=H).status_code == 200
    assert client.get("/documents", headers=H).json() == []


def test_live_data_question_runs_readonly_sql(client):
    body = client.post("/ask", headers=H, json={"question": "Which products are low in stock?"}).json()
    assert body["meta"]["sql"].upper().startswith("SELECT")
    assert "sqlError" not in body["meta"]
    assert "live data" in body["text"].lower()


def test_malicious_sql_from_llm_is_blocked(client):
    # FakeLLM returns "DROP TABLE products" for this question
    body = client.post("/ask", headers=H, json={"question": "please drop everything"}).json()
    assert "blocked" in body["meta"]["sqlError"]
    s = get_settings()
    with psycopg.connect(s.database_url) as conn:
        assert conn.execute("SELECT count(*) FROM products").fetchone()[0] >= 8


def test_rejects_unsupported_file(client):
    r = client.post("/documents", headers=H, files={"file": ("virus.exe", io.BytesIO(b"MZ"), "application/octet-stream")})
    assert r.status_code == 400


def test_pdf_upload(client):
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    c.drawString(72, 750, "The placement drive for Infosys is on 14 December in Hall B.")
    c.showPage()
    c.drawString(72, 750, "Carry two copies of your resume.")
    c.save()
    r = client.post("/documents", headers=H, files={"file": ("drive.pdf", io.BytesIO(buf.getvalue()), "application/pdf")})
    assert r.status_code == 200, r.text
    assert r.json()["numPages"] == 2
    body = client.post("/ask", headers=H, json={"question": "When is the Infosys placement drive?"}).json()
    assert body["meta"]["sources"][0]["page"] == 1


def test_worker_streams_then_sends_final_reply(client):
    """BotWorker.handle_message without a real broker: capture what it would send."""
    sent = []

    async def fake_send(topic, chat_id, value):
        sent.append((topic, value))

    worker = BotWorker.__new__(BotWorker)  # skip creating real Kafka clients
    worker.agent, worker.s = client.app.state.agent, get_settings()
    worker._send = fake_send

    chat_id = str(uuid.uuid4())
    msg = {"id": str(uuid.uuid4()), "chatId": chat_id, "senderId": USER, "text": "How many orders by status?"}
    client.portal.call(worker.handle_message, msg)

    topics = [t for t, _ in sent]
    assert topics[0] == "bot.stream" and sent[0][1]["kind"] == "status"
    assert any(v.get("kind") == "delta" for t, v in sent if t == "bot.stream")
    assert topics[-1] == "bot.replies"
    final = sent[-1][1]["message"]
    assert final["senderId"] == "chatbot" and final["meta"]["inReplyTo"] == msg["id"]
