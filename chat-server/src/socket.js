import { randomUUID } from "node:crypto";
import { authenticate } from "./auth.js";
import { getChatMembers, isBotChat } from "./db.js";
import { publish as kafkaPublish } from "./kafka.js";
import { BOT_USER_ID, TOPICS } from "./config.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 4000;

/** Sends an event to every member of a chat (each user has a personal room). */
export async function emitToChat(io, chatId, event, payload, { exceptUserId } = {}) {
  const members = await getChatMembers(chatId);
  for (const uid of members) {
    if (uid !== exceptUserId && uid !== BOT_USER_ID) io.to(`user:${uid}`).emit(event, payload);
  }
}

/** Forwards a bot event read from Kafka to the users of that chat. */
export async function handleBotEvent(io, topic, event) {
  if (topic === TOPICS.BOT_STREAM) {
    await emitToChat(io, event.chatId, "bot:stream", event);
  } else if (topic === TOPICS.BOT_REPLIES) {
    await emitToChat(io, event.message.chatId, "message:new", { message: event.message });
  }
}

/** Very small rate limiter: max `limit` actions per `windowMs` per socket. */
function rateLimiter(limit, windowMs) {
  let count = 0;
  let windowStart = Date.now();
  return () => {
    const now = Date.now();
    if (now - windowStart > windowMs) {
      windowStart = now;
      count = 0;
    }
    return ++count <= limit;
  };
}

/**
 * @param io       Socket.IO server
 * @param publish  function(topic, key, value) — Kafka in production; tests pass a fake
 */
export function setupSocket(io, { publish = kafkaPublish } = {}) {
  const onlineCount = new Map(); // uid -> number of open tabs/devices

  // 1) Every socket must log in first (Firebase ID token in handshake.auth.token)
  io.use(async (socket, next) => {
    try {
      socket.data.user = await authenticate(socket.handshake.auth?.token);
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const { uid } = socket.data.user;
    socket.join(`user:${uid}`); // personal room: all this user's tabs/devices

    const count = (onlineCount.get(uid) || 0) + 1;
    onlineCount.set(uid, count);
    if (count === 1) socket.broadcast.emit("presence:update", { userId: uid, online: true });

    const allowSend = rateLimiter(10, 5000);

    // 2) Sending a message
    socket.on("message:send", async (payload, ack = () => {}) => {
      try {
        const { chatId, text = "", imageUrl = null } = payload || {};
        const cleanText = String(text).trim();

        if (!allowSend()) return ack({ ok: false, error: "You are sending too fast. Slow down a bit." });
        if (!UUID_RE.test(chatId || "")) return ack({ ok: false, error: "Bad chat id" });
        if (!cleanText && !imageUrl) return ack({ ok: false, error: "Empty message" });
        if (cleanText.length > MAX_TEXT) return ack({ ok: false, error: "Message is too long" });
        if (imageUrl && !/^\/uploads\/[\w-]+\.(png|jpe?g|gif|webp)$/.test(imageUrl))
          return ack({ ok: false, error: "Bad image" });

        const members = await getChatMembers(chatId);
        if (!members.includes(uid)) return ack({ ok: false, error: "Not your chat" });

        const message = {
          id: randomUUID(),
          chatId,
          senderId: uid,
          text: cleanText,
          imageUrl,
          createdAt: new Date().toISOString(),
        };

        // Kafka FIRST: once Kafka has it, the message is safe (the persistence
        // worker will save it and the bot will answer it, even if they are down
        // right now and catch up later).
        await publish(TOPICS.CHAT_MESSAGES, chatId, {
          message,
          toBot: isBotChat(members),
          senderName: socket.data.user.name,
        });

        // Then deliver it in real time to everyone in the chat.
        await emitToChat(io, chatId, "message:new", { message });
        ack({ ok: true, message });
      } catch (err) {
        console.error("message:send failed:", err.message);
        ack({ ok: false, error: "Could not send. Please try again." });
      }
    });

    // 3) Typing indicator (not stored anywhere — only live)
    socket.on("typing", async ({ chatId, isTyping } = {}) => {
      if (!UUID_RE.test(chatId || "")) return;
      const members = await getChatMembers(chatId).catch(() => []);
      if (!members.includes(uid)) return;
      emitToChat(io, chatId, "typing", { chatId, userId: uid, isTyping: !!isTyping }, { exceptUserId: uid });
    });

    // 4) "Which of these users are online?"
    socket.on("presence:query", (userIds, ack = () => {}) => {
      if (!Array.isArray(userIds)) return ack([]);
      ack(
        userIds.slice(0, 200).map((id) => ({
          userId: id,
          online: id === BOT_USER_ID || onlineCount.has(id),
        }))
      );
    });

    socket.on("disconnect", () => {
      const left = (onlineCount.get(uid) || 1) - 1;
      if (left <= 0) {
        onlineCount.delete(uid);
        io.emit("presence:update", { userId: uid, online: false });
      } else {
        onlineCount.set(uid, left);
      }
    });
  });
}
