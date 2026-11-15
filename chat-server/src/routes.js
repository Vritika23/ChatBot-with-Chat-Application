import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { httpAuth } from "./auth.js";
import { config, BOT_USER_ID } from "./config.js";
import {
  searchUsers, getUser, getOrCreateChat, listChats, getChatForUser,
  getChatMembers, getMessages,
} from "./db.js";

fs.mkdirSync(config.uploadDir, { recursive: true });

const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

// Images are saved on disk with a random name + extension based on the
// real MIME type (never the user's file name).
const imageUpload = multer({
  storage: multer.diskStorage({
    destination: config.uploadDir,
    filename: (_req, file, cb) => cb(null, `${randomUUID()}.${IMAGE_TYPES[file.mimetype]}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, !!IMAGE_TYPES[file.mimetype]),
});

// Documents for the bot are kept in memory and forwarded to bot-service.
const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    cb(null, ["application/pdf", "text/plain", "text/markdown"].includes(file.mimetype) ||
      /\.(pdf|txt|md)$/i.test(file.originalname)),
});

const UUID_RE = /^[0-9a-f-]{36}$/i;

export function apiRouter() {
  const r = express.Router();
  r.use(httpAuth);

  r.get("/me", (req, res) => res.json({ uid: req.user.uid, displayName: req.user.name }));

  r.get("/users/search", async (req, res) => {
    const q = String(req.query.q || "").trim().slice(0, 50);
    if (!q) return res.json([]);
    const users = await searchUsers(q, req.user.uid);
    res.json(users.map((u) => ({ uid: u.id, displayName: u.display_name, photoURL: u.photo_url, isBot: u.is_bot })));
  });

  r.get("/chats", async (req, res) => res.json(await listChats(req.user.uid)));

  // Open (or create) the 1:1 chat with another user
  r.post("/chats", express.json(), async (req, res) => {
    const otherId = String(req.body?.userId || "");
    if (!otherId || otherId === req.user.uid) return res.status(400).json({ error: "Bad user" });
    if (!(await getUser(otherId))) return res.status(404).json({ error: "User not found" });
    const chatId = await getOrCreateChat(req.user.uid, otherId);
    res.json(await getChatForUser(chatId, req.user.uid));
  });

  r.get("/chats/:id/messages", async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Bad chat id" });
    const members = await getChatMembers(id);
    if (!members.includes(req.user.uid)) return res.status(403).json({ error: "Not your chat" });
    res.json(await getMessages(id, { before: req.query.before, limit: req.query.limit }));
  });

  r.post("/uploads", imageUpload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Only images up to 5 MB" });
    res.json({ url: `/uploads/${req.file.filename}` });
  });

  // ---------- Bot documents (proxied to bot-service) ----------

  const botFetch = (path, init = {}, userId) =>
    fetch(`${config.botServiceUrl}${path}`, {
      ...init,
      headers: { ...(init.headers || {}), "X-User-Id": userId },
    });

  r.get("/bot/documents", async (req, res) => {
    try {
      const r2 = await botFetch("/documents", {}, req.user.uid);
      res.status(r2.status).json(await r2.json());
    } catch {
      res.status(503).json({ error: "Bot service is not reachable" });
    }
  });

  r.post("/bot/documents", docUpload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Send a PDF, .txt or .md file (max 15 MB)" });
    try {
      const form = new FormData();
      form.append("file", new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);
      const r2 = await botFetch("/documents", { method: "POST", body: form }, req.user.uid);
      res.status(r2.status).json(await r2.json());
    } catch {
      res.status(503).json({ error: "Bot service is not reachable" });
    }
  });

  r.delete("/bot/documents/:id", async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Bad id" });
    try {
      const r2 = await botFetch(`/documents/${req.params.id}`, { method: "DELETE" }, req.user.uid);
      res.status(r2.status).json(await r2.json());
    } catch {
      res.status(503).json({ error: "Bot service is not reachable" });
    }
  });

  r.get("/bot/info", (_req, res) => res.json({ botUserId: BOT_USER_ID }));

  // eslint-disable-next-line no-unused-vars
  r.use((err, _req, res, _next) => {
    console.error(err);
    res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 500).json({ error: err.message || "Server error" });
  });

  return r;
}
