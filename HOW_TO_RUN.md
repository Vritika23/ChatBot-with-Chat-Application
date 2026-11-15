# How to Run Let's Chat

The app is **5 separate programs + 1 database**, each running in its own terminal tab.
**Start order matters**, because each program connects to the ones started before it:

**Postgres → Kafka → chat-server → worker → bot-service → client**

| # | Tab | What it is | Command | Port |
|---|---|---|---|---|
| 0 | (app) | PostgreSQL + pgvector | Postgres.app → Start | 5432 |
| 1 | Kafka | Message bus | `bin/kafka-server-start.sh ...` | 9092 |
| 2 | chat-server | Main backend (REST + Socket.IO) | `npm run dev` | 4000 |
| 3 | worker | Saves messages to Postgres | `npm run dev:worker` | — |
| 4 | bot-service | AI bot (FastAPI) | `uvicorn app.main:app --port 8000` | 8000 |
| 5 | client | React website (Vite) | `npm run dev` | 5173 |

---

## First-time setup (only once)

You only need this on a new machine. The commands are for macOS (zsh); on Linux, install the same tools with your package manager.

### 1. PostgreSQL with pgvector
Download **Postgres.app** from https://postgresapp.com (it includes pgvector) → move it to Applications → open it → **Initialize**.
Then put its tools on your PATH:
```bash
echo 'export PATH="/Applications/Postgres.app/Contents/Versions/latest/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
pg_isready -h localhost      # → localhost:5432 - accepting connections
```

### 2. Create the database and load the schema
Run these from the project root:
```bash
psql postgres -c "CREATE ROLE chat LOGIN PASSWORD 'chat_dev_password';"
psql postgres -c "CREATE DATABASE chatdb OWNER chat;"
psql chatdb -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;"
PGPASSWORD=chat_dev_password psql -h localhost -U chat -d chatdb -v ON_ERROR_STOP=1 -f db/01-schema.sql
POSTGRES_USER=$(whoami) POSTGRES_DB=chatdb PGHOST=localhost bash db/02-readonly-role.sh
```
- The first three lines create the app's login (`chat`), its database, and the `vector` extension (extensions need a superuser, which is your Mac user).
- `01-schema.sql` creates the tables and the demo data (`products`, `orders`).
- `02-readonly-role.sh` creates `bot_reader`, the **read-only** login the bot uses for SQL. Run it as your Mac user, because creating a role needs superuser rights.

⚠️ Run `01-schema.sql` only once, because its demo data inserts would be duplicated.

### 3. Java 21 and Kafka 3.8.1
Kafka runs on Java. Use Kafka **3.8**, not 4.x, because the chat-server's Kafka client (kafkajs) may not work with Kafka 4.
```bash
mkdir -p ~/dev-tools && cd ~/dev-tools

# Java 21 (Eclipse Temurin, Apple Silicon build; use x64 instead of aarch64 on an Intel Mac)
curl -L -o jdk21.tar.gz "https://api.adoptium.net/v3/binary/latest/21/ga/mac/aarch64/jdk/hotspot/normal/eclipse"
tar -xzf jdk21.tar.gz && rm jdk21.tar.gz
ls -d jdk-21*                     # note the exact folder name, e.g. jdk-21.0.13+9

# Kafka
curl -LO https://archive.apache.org/dist/kafka/3.8.1/kafka_2.13-3.8.1.tgz
tar -xzf kafka_2.13-3.8.1.tgz
```
Open `~/dev-tools/kafka_2.13-3.8.1/config/kraft/server.properties` and change two lines:
```properties
# the default is /tmp, which macOS cleans on reboot (that would delete all topics)
log.dirs=/Users/<your-mac-username>/dev-tools/kafka-data
# topics get 3 partitions by default
num.partitions=3
```
Then format Kafka's storage. This gives the cluster an ID, and you do it only once:
```bash
export JAVA_HOME=~/dev-tools/jdk-21.0.13+9/Contents/Home     # use your folder name from above
cd ~/dev-tools/kafka_2.13-3.8.1
bin/kafka-storage.sh format -t "$(bin/kafka-storage.sh random-uuid)" -c config/kraft/server.properties
```
Kafka runs in **KRaft mode**, so it needs no ZooKeeper. The chat-server creates the app's topics when it first starts.

### 4. Install the dependencies
From the project root:
```bash
cd chat-server && npm install
cd ../client && npm install
cd ../bot-service && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
```
`.venv` is a private Python environment just for this project, so nothing is installed globally.

### 5. Create `.env`
```bash
cp .env.example .env
```
Then fill in:
- the **Firebase** web config (`FIREBASE_PROJECT_ID` and the `VITE_FIREBASE_*` values). In Firebase → Authentication, turn on **Email/Password** sign-in.
- **`GEMINI_API_KEY`**, from https://aistudio.google.com/apikey

The database and Kafka values already match the setup above. Never commit `.env` (it's git-ignored).

> **No Firebase yet?** Set `AUTH_MODE=dev` and `VITE_AUTH_MODE=dev` to log in with just a name (only on your own laptop).
> **No Gemini key yet?** Set `LLM_PROVIDER=fake` to get canned bot answers.

---

## Daily run

Open VS Code and use a new terminal tab (`+`) for each step.

### Step 0: Postgres (the database)
Open **Postgres.app** and click **Start**. Wait until it shows "Running" (port 5432).

*Why:* it stores all messages, users and document vectors. Everything else needs it.

### Tab 1: Kafka (the message bus)
```bash
export JAVA_HOME=~/dev-tools/jdk-21.0.13+9/Contents/Home
cd ~/dev-tools/kafka_2.13-3.8.1
bin/kafka-server-start.sh config/kraft/server.properties
```
Wait for **`Kafka Server started`**. Kafka now listens on `localhost:9092`.

*Why:* every chat message is published to Kafka first. The worker and the bot then read it from there.

### Tab 2: chat-server (the main backend)
```bash
cd ~/Downloads/ChatBot-with-Chat-Application/chat-server
npm run dev
```
Wait for **`💬 chat-server on http://localhost:4000`**.

*Why:* it handles login checks, the REST API and Socket.IO (live messages). It also creates the Kafka topics if they are missing.
`npm run dev` reads `../.env` by itself.

### Tab 3: persistence worker (saves messages)
```bash
cd ~/Downloads/ChatBot-with-Chat-Application/chat-server
npm run dev:worker
```
Wait for **`🗄️ persistence worker running`**.

*Why:* it reads messages from Kafka and saves them in Postgres. Saving is idempotent, so a duplicate message is stored only once.

### Tab 4: bot-service (the AI bot, Python)
```bash
cd ~/Downloads/ChatBot-with-Chat-Application/bot-service
source .venv/bin/activate
set -a; source ../.env; set +a
uvicorn app.main:app --port 8000
```
Wait for **`🤖 bot worker listening on chat.messages`**.

*Why:*
- `source .venv/bin/activate` switches to the project's private Python.
- `set -a; source ../.env; set +a` loads the settings (Gemini key, DB URLs), because Python doesn't read `.env` by itself.
- `uvicorn` starts the FastAPI app.

⚠️ Send bot messages only **after** "listening" appears. The bot skips messages that arrived before it started.

### Tab 5: client (the React website)
```bash
cd ~/Downloads/ChatBot-with-Chat-Application/client
set -a; source ../.env; set +a
npm run dev
```
Open **http://localhost:5173**.

*Why:* Vite also needs the `.env` values loaded (`VITE_AUTH_MODE` and the Firebase config). Without them, login breaks.

---

## Test it

1. Register or log in with Firebase in a normal browser window (user A) and in an incognito window (user B).
2. Have A search for B and chat. Messages should appear instantly in both windows.
3. Open the **ChatBot** chat, attach a PDF, and ask about it. You should get an answer with `[Source 1]`.
4. Ask *"which products are low on stock?"* to test the live SQL answer.

## Stopping

Press `Ctrl + C` in each tab, in the reverse order (client first, Kafka last). Then stop Postgres.app.

---

## Running the tests

```bash
# chat-server (Kafka is replaced by an in-memory fake)
cd chat-server && npm test

# bot-service (FakeLLM, no Kafka, no API key needed)
cd bot-service && source .venv/bin/activate
LLM_PROVIDER=fake KAFKA_ENABLED=false pytest -q
```

---

## Common problems

| Problem | Fix |
|---|---|
| Login page broken / wrong auth mode | You forgot `set -a; source ../.env; set +a` in the client tab |
| Bot never answers | Wait for "bot worker listening" before sending, and check that Kafka (tab 1) is running |
| `password authentication failed` | The `DATABASE_URL` in `.env` doesn't match the password you created in Postgres |
| chat-server can't connect to Kafka | Kafka (tab 1) isn't running, or `.env` has a wrong `KAFKA_BROKERS` (it should be `localhost:9092`) |
| Gemini 429 / quota errors | The free tier is limited per day per model. Wait, or set `GEMINI_FALLBACK_MODELS` in `.env` |
| `Port already in use` | An old process is still running. Close the old tab, or run `lsof -i :4000` (or the relevant port) to find it |

