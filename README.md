# Let's Chat — real-time chat with an AI assistant (Socket.IO · Kafka · RAG)

A full-stack chat app where people message each other in real time, and an AI **ChatBot**
answers questions from **the user's own PDFs (RAG)** and from **live database tables
(safe text-to-SQL)**. Messages flow through **Apache Kafka**, so saving them and generating
AI answers never slow down the chat.

<!-- TODO: add a screenshot / demo GIF here after running it with your Gemini key:
![ChatBot answering from a document and from live data](docs/screenshot-bot.png) -->

## Features

- **Real-time 1:1 chat** with Socket.IO: instant delivery, typing indicator, online/offline status, image messages
- **Firebase Auth** login; all data lives in **PostgreSQL**
- **Event-driven backend with Kafka**: chat server, persistence worker and AI service are separate consumers
- **RAG chatbot**: upload PDF/TXT/MD → chunks → Gemini embeddings → **pgvector** search → answer with cited sources
- **Live-data answers**: the bot writes a SQL query, which is **validated (sqlglot) and run by a read-only DB role**
- **Streaming answers**: the bot's reply appears word by word, with steps like "Checking live data…"
- Conversation memory (last 10 messages), Markdown answers, "show sources" and "show SQL" panels
- Automated tests + GitHub Actions CI

## Architecture

```
┌────────────┐  Socket.IO   ┌──────────────────────┐   produce    ┌───────────────────────┐
│  React app │◄────────────►│  chat-server (Node)  │─────────────►│ Kafka: chat.messages  │
│  (Vite)    │   REST /api  │  auth, rooms, typing │              └─────┬───────────┬─────┘
└────────────┘              └──────────▲───────────┘                    │           │
                                       │ consume                         │           │
                            ┌──────────┴───────────┐          consume    │           │ consume
                            │ Kafka: bot.stream    │◄──────┐             ▼           ▼
                            │ Kafka: bot.replies   │       │   ┌──────────────┐ ┌────────────────────┐
                            └──────────────────────┘       └───│ bot-service  │ │ persistence-worker │
                                                                │ (FastAPI)    │ │ saves to Postgres  │
                                                                │ RAG + SQL    │ └─────────┬──────────┘
                                                                └──────┬───────┘           │
                                                                       ▼                   ▼
                                                     ┌────────────────────────────────────────────┐
                                                     │ PostgreSQL + pgvector                      │
                                                     │ users · chats · messages · documents ·     │
                                                     │ document_chunks(vector) · products · orders│
                                                     └────────────────────────────────────────────┘
```

**Life of a message**

1. The browser sends `message:send` over Socket.IO with a Firebase ID token.
2. `chat-server` checks the user is in that chat, gives the message an id, and **publishes it to Kafka**
   (key = chatId, so one chat's messages always stay in order). Then it pushes the message to the other
   person's socket instantly.
3. `persistence-worker` (consumer group `persistence`) saves it to Postgres. The insert is idempotent,
   so if Kafka delivers an event twice, it is still stored once.
4. If the chat is with the ChatBot, `bot-service` (consumer group `bot-service`) answers:
   - searches the user's document chunks in pgvector **and**, at the same time, asks Gemini whether live
     data is needed → validates the SQL → runs it as the read-only `bot_reader` role
   - streams status and answer pieces to `bot.stream`, then the final answer to `bot.replies`
5. `chat-server` consumes `bot.*` and forwards them to the user's sockets; the worker saves the final reply.

## Tech stack

| Part | Tech |
|---|---|
| Frontend | React 18, Vite, Socket.IO client, react-markdown, Firebase Auth |
| Chat server | Node.js 22, Express 5, Socket.IO, kafkajs, pg, firebase-admin |
| AI service | Python, FastAPI, aiokafka, psycopg 3, pgvector, Google Gen AI SDK (Gemini), sqlglot, pypdf |
| Data | PostgreSQL 16 + pgvector (HNSW index), Apache Kafka 3.8 (KRaft) |
| DevOps | GitHub Actions CI |

## Run it

**Needs:** Node 22, Python 3.12, PostgreSQL with **pgvector** (e.g. Postgres.app on macOS), Java 21 + Apache Kafka 3.8,
a [Gemini API key](https://aistudio.google.com/apikey), and a Firebase project with **Email/Password** sign-in turned on.

```bash
git clone https://github.com/Vritika23/ChatBot-with-Chat-Application.git
cd ChatBot-with-Chat-Application
cp .env.example .env        # then fill in GEMINI_API_KEY and the Firebase values
```

Then follow **[HOW_TO_RUN.md](HOW_TO_RUN.md)**. In short, start each service in its own terminal tab, in this order:

| # | Service | Command | Port |
|---|---|---|---|
| 0 | PostgreSQL | (Postgres.app) | 5432 |
| 1 | Kafka | `bin/kafka-server-start.sh config/kraft/server.properties` | 9092 |
| 2 | chat-server | `cd chat-server && npm run dev` | 4000 |
| 3 | persistence worker | `cd chat-server && npm run dev:worker` | — |
| 4 | bot-service | `cd bot-service && uvicorn app.main:app --port 8000` (after loading `.env`) | 8000 |
| 5 | client | `cd client && npm run dev` (after loading `.env`) | 5173 |

Open http://localhost:5173, register two users (two browsers or one incognito window), and chat.
Every user automatically gets a **ChatBot** chat.

Try asking the bot:

- "Which products are almost out of stock?" → live SQL on `products`
- "How many orders are pending, and who placed them?" → SQL join on `orders` + `products`
- Upload your syllabus PDF with **📄 My documents**, then "What topics are in unit 3?" → RAG with sources

**Quick local test without Firebase:** set `AUTH_MODE=dev` and `VITE_AUTH_MODE=dev` in `.env`.
You log in with just a name. Only use this on your own laptop.

## Tests

```bash
cd chat-server && npm test                                  # sockets, auth, chats, Kafka events, idempotency
cd bot-service && LLM_PROVIDER=fake KAFKA_ENABLED=false pytest -q   # RAG, SQL safety, worker
```

The tests need Postgres with `db/` loaded. They use a fake LLM, so they need no API key.

## Security notes

- The Gemini key lives **only** in `bot-service` (server side). `.env` is git-ignored.
- Every socket connection and API call is verified with Firebase Admin (`verifyIdToken`).
- Users can only read or send messages in chats they belong to, and only search their own documents.
- LLM-written SQL goes through 3 checks: sqlglot allow-list (single SELECT, allowed tables only, no
  dangerous functions), a **read-only** Postgres role with `SELECT` on only those tables, and a 3 s timeout.
- The browser never calls `bot-service` directly; only `chat-server` does (after checking the user's token).

## What I would add next

- Socket.IO Redis adapter so several chat-server instances share presence
- Group chats and read receipts
- Image understanding (Gemini is multimodal) for photos sent to the bot
- Re-ranking of retrieved chunks, and hybrid (keyword + vector) search
