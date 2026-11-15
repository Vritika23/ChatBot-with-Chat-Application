"""
RAG = Retrieval-Augmented Generation.

Upload time (ingest):
    file → text per page → small overlapping chunks → embedding vectors → Postgres (pgvector)

Question time (search):
    question → embedding → find the closest chunks (cosine distance) → give them to the LLM
"""
from __future__ import annotations

import io
import re

from pypdf import PdfReader

from .config import Settings
from .db import Database
from .llm import LLM


class DocumentError(ValueError):
    pass


# ---------- 1. read the file ----------

def extract_pages(filename: str, data: bytes) -> list[tuple[int, str]]:
    """Returns [(page_number, text), ...]."""
    if filename.lower().endswith(".pdf"):
        try:
            reader = PdfReader(io.BytesIO(data))
            pages = [(i + 1, page.extract_text() or "") for i, page in enumerate(reader.pages)]
        except Exception as e:  # broken / encrypted PDF
            raise DocumentError(f"Could not read this PDF: {e}") from e
    else:
        pages = [(1, data.decode("utf-8", errors="ignore"))]

    pages = [(n, re.sub(r"[ \t]+", " ", t).strip()) for n, t in pages]
    if not any(t for _, t in pages):
        raise DocumentError("No text found. Scanned (image-only) PDFs are not supported yet.")
    return pages


# ---------- 2. split into chunks ----------

def chunk_pages(pages: list[tuple[int, str]], size: int, overlap: int) -> list[tuple[int, str]]:
    """
    Packs whole sentences into chunks of about `size` characters.
    The last ~`overlap` characters of a chunk are repeated at the start of the
    next one, so an idea that crosses the border is not cut in half.
    """
    chunks: list[tuple[int, str]] = []
    for page_no, text in pages:
        sentences = re.split(r"(?<=[.!?])\s+|\n{2,}", text)
        current = ""
        for sentence in sentences:
            sentence = sentence.strip()
            if not sentence:
                continue
            # a single huge "sentence" (e.g. a table) is cut by force
            while len(sentence) > size:
                chunks.append((page_no, sentence[:size]))
                sentence = sentence[size - overlap :]
            if current and len(current) + len(sentence) + 1 > size:
                chunks.append((page_no, current))
                current = current[-overlap:].split(" ", 1)[-1] if overlap else ""
            current = f"{current} {sentence}".strip()
        if current:
            chunks.append((page_no, current))
    return chunks


# ---------- 3. store ----------

async def ingest(db: Database, llm: LLM, s: Settings, user_id: str, filename: str, data: bytes) -> dict:
    pages = extract_pages(filename, data)
    chunks = chunk_pages(pages, s.chunk_size, s.chunk_overlap)
    vectors = await llm.embed([c for _, c in chunks], task="RETRIEVAL_DOCUMENT")

    async with db.main.connection() as conn:
        async with conn.transaction():
            cur = await conn.execute(
                """INSERT INTO documents (user_id, filename, num_pages, num_chunks)
                   VALUES (%s, %s, %s, %s)
                   RETURNING id, filename, num_pages, num_chunks, created_at""",
                (user_id, filename[:200], len(pages), len(chunks)),
            )
            doc = await cur.fetchone()
            async with conn.cursor() as c2:
                await c2.executemany(
                    """INSERT INTO document_chunks (document_id, user_id, chunk_index, page, content, embedding)
                       VALUES (%s, %s, %s, %s, %s, %s::vector)""",
                    [
                        (doc["id"], user_id, i, page, text, vec)
                        for i, ((page, text), vec) in enumerate(zip(chunks, vectors))
                    ],
                )
    return _doc_dto(doc)


async def list_documents(db: Database, user_id: str) -> list[dict]:
    async with db.main.connection() as conn:
        cur = await conn.execute(
            """SELECT id, filename, num_pages, num_chunks, created_at FROM documents
                WHERE user_id = %s ORDER BY created_at DESC""",
            (user_id,),
        )
        return [_doc_dto(r) for r in await cur.fetchall()]


async def delete_document(db: Database, user_id: str, doc_id: str) -> bool:
    async with db.main.connection() as conn:
        cur = await conn.execute(
            "DELETE FROM documents WHERE id = %s AND user_id = %s", (doc_id, user_id)
        )
        return cur.rowcount == 1


def _doc_dto(r: dict) -> dict:
    return {
        "id": str(r["id"]),
        "filename": r["filename"],
        "numPages": r["num_pages"],
        "numChunks": r["num_chunks"],
        "createdAt": r["created_at"].isoformat(),
    }


# ---------- 4. search ----------

async def search(db: Database, llm: LLM, s: Settings, user_id: str, query: str) -> list[dict]:
    """Top-k chunks from THIS user's documents that are similar enough to the question."""
    async with db.main.connection() as conn:
        cur = await conn.execute("SELECT 1 FROM documents WHERE user_id = %s LIMIT 1", (user_id,))
        if await cur.fetchone() is None:
            return []  # user has no documents → skip the embedding call

    [qvec] = await llm.embed([query], task="RETRIEVAL_QUERY")
    async with db.main.connection() as conn:
        cur = await conn.execute(
            """SELECT c.content, c.page, d.filename,
                      1 - (c.embedding <=> %(q)s::vector) AS score
                 FROM document_chunks c
                 JOIN documents d ON d.id = c.document_id
                WHERE c.user_id = %(u)s
                ORDER BY c.embedding <=> %(q)s::vector
                LIMIT %(k)s""",
            {"q": qvec, "u": user_id, "k": s.top_k},
        )
        rows = await cur.fetchall()
    return [
        {"filename": r["filename"], "page": r["page"], "score": round(float(r["score"]), 3), "content": r["content"]}
        for r in rows
        if r["score"] >= s.min_similarity
    ]
