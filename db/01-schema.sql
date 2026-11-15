-- ============================================================
-- Let's Chat — database schema (Postgres 16 + pgvector)
-- Runs automatically the first time the Postgres container starts.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- Chat app ----------

-- Users come from Firebase Auth. The id is the Firebase uid.
CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    email        TEXT,
    photo_url    TEXT,
    is_bot       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_display_name_idx ON users (lower(display_name));

-- A 1:1 chat. pair_key = "<smaller uid>:<bigger uid>" so the same two
-- people can never get two chats.
CREATE TABLE IF NOT EXISTS chats (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pair_key          TEXT UNIQUE NOT NULL,
    last_message_text TEXT,
    last_message_at   TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_members (
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS chat_members_user_idx ON chat_members (user_id);

-- Messages are written by the Kafka "persistence" worker.
-- The id is created by the chat server, so if Kafka delivers the same
-- event twice, ON CONFLICT DO NOTHING keeps only one copy (idempotent).
CREATE TABLE IF NOT EXISTS messages (
    id         UUID PRIMARY KEY,
    chat_id    UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id  TEXT NOT NULL REFERENCES users(id),
    text       TEXT NOT NULL DEFAULT '',
    image_url  TEXT,
    meta       JSONB,              -- bot extras: sources, SQL used
    created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_chat_time_idx ON messages (chat_id, created_at DESC);

-- ---------- RAG (documents uploaded to the bot) ----------

CREATE TABLE IF NOT EXISTS documents (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename   TEXT NOT NULL,
    num_pages  INT NOT NULL DEFAULT 0,
    num_chunks INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 768 = embedding size we ask Gemini for (EMBEDDING_DIM in .env).
CREATE TABLE IF NOT EXISTS document_chunks (
    id          BIGSERIAL PRIMARY KEY,
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL,
    chunk_index INT NOT NULL,
    page        INT,
    content     TEXT NOT NULL,
    embedding   vector(768) NOT NULL
);
CREATE INDEX IF NOT EXISTS document_chunks_user_idx ON document_chunks (user_id);
-- HNSW index = fast approximate nearest-neighbour search by cosine distance
CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx
    ON document_chunks USING hnsw (embedding vector_cosine_ops);

-- ---------- "Live" business data the bot can query ----------
-- Demo store data. Swap these for any tables you like and list them in
-- BOT_SQL_TABLES. The bot reads them with a READ-ONLY database role.

CREATE TABLE IF NOT EXISTS products (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    category   TEXT NOT NULL,
    price      NUMERIC(10,2) NOT NULL,
    stock      INT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
    id            SERIAL PRIMARY KEY,
    product_id    INT NOT NULL REFERENCES products(id),
    customer_name TEXT NOT NULL,
    quantity      INT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('pending','shipped','delivered','cancelled')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Seed data ----------

INSERT INTO users (id, display_name, photo_url, is_bot)
VALUES ('chatbot', 'ChatBot', '/bot.png', TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO products (name, category, price, stock) VALUES
    ('Wireless Mouse',        'Electronics', 799.00,  42),
    ('Mechanical Keyboard',   'Electronics', 3499.00, 8),
    ('USB-C Hub',             'Electronics', 1599.00, 0),
    ('Notebook (A5, 200pg)',  'Stationery',  149.00,  310),
    ('Gel Pen Pack (10)',     'Stationery',  199.00,  95),
    ('Laptop Backpack',       'Bags',        1899.00, 17),
    ('Water Bottle 1L',       'Lifestyle',   499.00,  63),
    ('Desk Lamp LED',         'Home',        1299.00, 5);

INSERT INTO orders (product_id, customer_name, quantity, status, created_at) VALUES
    (1, 'Aarav',  2, 'delivered', now() - interval '6 days'),
    (2, 'Diya',   1, 'shipped',   now() - interval '2 days'),
    (4, 'Kabir',  5, 'pending',   now() - interval '3 hours'),
    (6, 'Meera',  1, 'delivered', now() - interval '9 days'),
    (2, 'Rohan',  1, 'pending',   now() - interval '1 hour'),
    (7, 'Ishita', 3, 'cancelled', now() - interval '4 days'),
    (5, 'Aarav',  2, 'shipped',   now() - interval '1 day');
