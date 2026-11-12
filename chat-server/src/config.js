import os from "node:os";
import path from "node:path";

export const config = {
  port: Number(process.env.PORT || 4000),
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://chat:chat_dev_password@localhost:5432/chatdb",
  kafkaBrokers: (process.env.KAFKA_BROKERS || "localhost:9094").split(","),
  authMode: process.env.AUTH_MODE || "firebase", // "firebase" | "dev"
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID,
  clientOrigins: (process.env.CLIENT_ORIGIN || "http://localhost:5173").split(","),
  botServiceUrl: process.env.BOT_SERVICE_URL || "http://localhost:8000",
  uploadDir: path.resolve(process.env.UPLOAD_DIR || "uploads"),
  // Each chat-server instance needs its own consumer group so that EVERY
  // instance receives every bot reply (it then forwards it only to the
  // sockets connected to it).
  instanceId: process.env.INSTANCE_ID || `${os.hostname()}-${process.pid}`,
};

export const BOT_USER_ID = "chatbot";

export const TOPICS = {
  CHAT_MESSAGES: "chat.messages", // every message a user sends
  BOT_STREAM: "bot.stream",       // live "typing" chunks of a bot reply
  BOT_REPLIES: "bot.replies",     // the final, complete bot reply
  DEAD_LETTERS: "dead.letters",   // events the persistence worker can never save (with the reason)
};
