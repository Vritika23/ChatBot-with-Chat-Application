import http from "node:http";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import { config, TOPICS } from "./config.js";
import { apiRouter } from "./routes.js";
import { setupSocket, handleBotEvent } from "./socket.js";
import { kafka, producer, ensureTopics } from "./kafka.js";
import { pool } from "./db.js";

const app = express();
app.use(cors({ origin: config.clientOrigins }));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use(
  "/uploads",
  express.static(config.uploadDir, {
    maxAge: "7d",
    setHeaders: (res) => res.setHeader("X-Content-Type-Options", "nosniff"),
  })
);
app.use("/api", apiRouter());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: config.clientOrigins } });
setupSocket(io);

/**
 * Listens for the bot's answers on Kafka and pushes them to the right users.
 * - bot.stream  → small pieces while the bot is "typing" (live only)
 * - bot.replies → the final message (also saved by the persistence worker)
 */
async function startBotReplyConsumer() {
  const consumer = kafka.consumer({ groupId: `chat-server-${config.instanceId}` });
  await consumer.connect();
  await consumer.subscribe({ topics: [TOPICS.BOT_STREAM, TOPICS.BOT_REPLIES], fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      let event;
      try {
        event = JSON.parse(message.value.toString());
      } catch {
        return; // ignore broken events
      }
      await handleBotEvent(io, topic, event);
    },
  });
  return consumer;
}

async function main() {
  await pool.query("SELECT 1");
  await ensureTopics();
  await producer.connect();
  const consumer = await startBotReplyConsumer();

  server.listen(config.port, () =>
    console.log(`💬 chat-server on http://localhost:${config.port} (auth: ${config.authMode})`)
  );

  const shutdown = async () => {
    console.log("Shutting down...");
    io.close();
    await consumer.disconnect().catch(() => {});
    await producer.disconnect().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Failed to start chat-server:", err);
  process.exit(1);
});
