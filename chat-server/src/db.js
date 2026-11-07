import pg from "pg";
import { config, BOT_USER_ID } from "./config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

// ---------- users ----------

export async function upsertUser({ uid, name, email, picture }) {
  await pool.query(
    `INSERT INTO users (id, display_name, email, photo_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           email        = COALESCE(EXCLUDED.email, users.email),
           photo_url    = COALESCE(EXCLUDED.photo_url, users.photo_url)`,
    [uid, name, email, picture]
  );
}

export async function getUser(id) {
  const { rows } = await pool.query(
    `SELECT id, display_name, photo_url, is_bot FROM users WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

export async function searchUsers(q, excludeId) {
  const { rows } = await pool.query(
    `SELECT id, display_name, photo_url, is_bot
       FROM users
      WHERE id <> $2 AND display_name ILIKE '%' || $1 || '%'
      ORDER BY is_bot DESC, display_name
      LIMIT 10`,
    [q, excludeId]
  );
  return rows;
}

// ---------- chats ----------

/** Returns the id of the 1:1 chat between a and b, creating it if needed. */
export async function getOrCreateChat(a, b) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // "DO UPDATE ... SET pair_key = pair_key" is a trick so RETURNING
    // gives us the id even when the row already existed.
    const { rows } = await client.query(
      `INSERT INTO chats (pair_key) VALUES ($1)
       ON CONFLICT (pair_key) DO UPDATE SET pair_key = EXCLUDED.pair_key
       RETURNING id`,
      [pairKey(a, b)]
    );
    const chatId = rows[0].id;
    await client.query(
      `INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2), ($1, $3)
       ON CONFLICT DO NOTHING`,
      [chatId, a, b]
    );
    await client.query("COMMIT");
    membersCache.delete(chatId);
    return chatId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** All chats of a user, with the "other person" and last message. */
export async function listChats(uid) {
  const { rows } = await pool.query(
    `SELECT c.id, c.last_message_text, c.last_message_at, c.created_at,
            u.id AS user_id, u.display_name, u.photo_url, u.is_bot
       FROM chat_members me
       JOIN chats c         ON c.id = me.chat_id
       JOIN chat_members ot ON ot.chat_id = c.id AND ot.user_id <> me.user_id
       JOIN users u         ON u.id = ot.user_id
      WHERE me.user_id = $1
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
    [uid]
  );
  return rows.map(toChatDto);
}

export async function getChatForUser(chatId, uid) {
  const chats = await listChats(uid);
  return chats.find((c) => c.chatId === chatId) || null;
}

function toChatDto(r) {
  return {
    chatId: r.id,
    lastMessage: r.last_message_text,
    lastMessageAt: r.last_message_at,
    user: {
      uid: r.user_id,
      displayName: r.display_name,
      photoURL: r.photo_url,
      isBot: r.is_bot,
    },
  };
}

// Members of a chat rarely change, so we cache them in memory.
const membersCache = new Map();

export async function getChatMembers(chatId) {
  if (membersCache.has(chatId)) return membersCache.get(chatId);
  const { rows } = await pool.query(
    `SELECT user_id FROM chat_members WHERE chat_id = $1`,
    [chatId]
  );
  const members = rows.map((r) => r.user_id);
  if (members.length) membersCache.set(chatId, members);
  return members;
}

export const isBotChat = (members) => members.includes(BOT_USER_ID);

// ---------- messages ----------

export async function getMessages(chatId, { before, limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, chat_id, sender_id, text, image_url, meta, created_at
       FROM messages
      WHERE chat_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2)
      ORDER BY created_at DESC
      LIMIT $3`,
    [chatId, before || null, Math.min(Number(limit) || 50, 100)]
  );
  return rows.reverse().map((r) => ({
    id: r.id,
    chatId: r.chat_id,
    senderId: r.sender_id,
    text: r.text,
    imageUrl: r.image_url,
    meta: r.meta,
    createdAt: r.created_at,
  }));
}

/**
 * Used by the Kafka persistence worker.
 * Idempotent: the same message id saved twice is stored once.
 */
export async function saveMessage(m) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query(
      `INSERT INTO messages (id, chat_id, sender_id, text, image_url, meta, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [m.id, m.chatId, m.senderId, m.text || "", m.imageUrl || null,
       m.meta ? JSON.stringify(m.meta) : null, m.createdAt]
    );
    if (res.rowCount === 1) {
      const preview = m.text?.trim() ? m.text.slice(0, 200) : m.imageUrl ? "📷 Photo" : "";
      // only move "last message" forward in time (Kafka can deliver out of order
      // across partitions, but one chat always uses one partition)
      await client.query(
        `UPDATE chats SET last_message_text = $2, last_message_at = $3
          WHERE id = $1 AND (last_message_at IS NULL OR last_message_at <= $3)`,
        [m.chatId, preview, m.createdAt]
      );
    }
    await client.query("COMMIT");
    return res.rowCount === 1;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
