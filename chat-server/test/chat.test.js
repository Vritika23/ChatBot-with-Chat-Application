/**
 * Integration test for the chat server.
 * Needs a running Postgres with db/01-schema.sql loaded.
 * Kafka is replaced by a tiny in-memory "bus" so the test can run anywhere:
 * every published event is saved straight away (like the persistence worker).
 *
 *   AUTH_MODE=dev DATABASE_URL=postgres://... npm test
 */
process.env.AUTH_MODE = "dev";
process.env.UPLOAD_DIR ??= "/tmp/chat-test-uploads";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { Server } from "socket.io";
import { io as ioClient } from "socket.io-client";

const { setupSocket, handleBotEvent } = await import("../src/socket.js");
const { apiRouter } = await import("../src/routes.js");
const { pool, saveMessage } = await import("../src/db.js");

const run = Date.now().toString(36); // unique users per test run
const tokens = {
  alice: `dev:alice${run}:Alice ${run}`,
  bob: `dev:bob${run}:Bob ${run}`,
  carol: `dev:carol${run}:Carol ${run}`,
};
const published = [];
let server, io, base;

// fake Kafka: remember the event and "persist" it
async function fakePublish(topic, key, value) {
  published.push({ topic, key, value });
  await saveMessage(value.message);
}

const api = (who, path, init = {}) =>
  fetch(`${base}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokens[who]}`, ...(init.headers || {}) },
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

const connect = (token) =>
  new Promise((resolve, reject) => {
    const s = ioClient(base, { auth: { token }, transports: ["websocket"], forceNew: true });
    s.on("connect", () => resolve(s));
    s.on("connect_error", (e) => reject(e));
  });

const once = (socket, event, ms = 2000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (data) => { clearTimeout(t); resolve(data); });
  });

const send = (socket, payload) => new Promise((resolve) => socket.emit("message:send", payload, resolve));

before(async () => {
  const app = express();
  app.use("/api", apiRouter());
  server = http.createServer(app);
  io = new Server(server);
  setupSocket(io, { publish: fakePublish });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  io.close();
  await pool.end();
});

test("rejects a socket without a valid token", async () => {
  await assert.rejects(connect("not-a-token"), /unauthorized/);
});

test("new user automatically gets a ChatBot chat", async () => {
  const { status, body } = await api("alice", "/chats");
  assert.equal(status, 200);
  assert.ok(body.some((c) => c.user.uid === "chatbot" && c.user.isBot));
});

let chatId;

test("search a user and open a 1:1 chat (same chat both ways)", async () => {
  await api("bob", "/me"); // bob logs in once so he exists
  const search = await api("alice", `/users/search?q=bob ${run}`);
  assert.equal(search.body.length, 1);
  const bobId = search.body[0].uid;

  const a = await api("alice", "/chats", { method: "POST", body: JSON.stringify({ userId: bobId }) });
  assert.equal(a.status, 200);
  chatId = a.body.chatId;

  const aliceId = `dev-alice${run}`;
  const b = await api("bob", "/chats", { method: "POST", body: JSON.stringify({ userId: aliceId }) });
  assert.equal(b.body.chatId, chatId);
});

test("message is published to Kafka, delivered live, and saved", async () => {
  const alice = await connect(tokens.alice);
  const bob = await connect(tokens.bob);
  try {
    const gotByBob = once(bob, "message:new");
    const ack = await send(alice, { chatId, text: "  Hello Bob!  " });
    assert.equal(ack.ok, true);
    assert.equal(ack.message.text, "Hello Bob!");

    const { message } = await gotByBob;
    assert.equal(message.id, ack.message.id);

    const event = published.at(-1);
    assert.equal(event.topic, "chat.messages");
    assert.equal(event.key, chatId); // key = chatId → keeps order per chat
    assert.equal(event.value.toBot, false);

    const history = await api("bob", `/chats/${chatId}/messages`);
    assert.equal(history.body.at(-1).text, "Hello Bob!");

    const chats = await api("bob", "/chats");
    assert.equal(chats.body.find((c) => c.chatId === chatId).lastMessage, "Hello Bob!");
  } finally {
    alice.close();
    bob.close();
  }
});

test("typing indicator goes only to the other person", async () => {
  const alice = await connect(tokens.alice);
  const bob = await connect(tokens.bob);
  try {
    let aliceGotOwnTyping = false;
    alice.on("typing", () => (aliceGotOwnTyping = true));
    const got = once(bob, "typing");
    alice.emit("typing", { chatId, isTyping: true });
    const t = await got;
    assert.equal(t.isTyping, true);
    assert.equal(t.userId, `dev-alice${run}`);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(aliceGotOwnTyping, false);
  } finally {
    alice.close();
    bob.close();
  }
});

test("outsider cannot send to or read someone else's chat", async () => {
  const carol = await connect(tokens.carol);
  try {
    const ack = await send(carol, { chatId, text: "sneaky" });
    assert.equal(ack.ok, false);
    const r = await api("carol", `/chats/${chatId}/messages`);
    assert.equal(r.status, 403);
  } finally {
    carol.close();
  }
});

test("input validation: empty, too long, foreign image url", async () => {
  const alice = await connect(tokens.alice);
  try {
    assert.equal((await send(alice, { chatId, text: "   " })).ok, false);
    assert.equal((await send(alice, { chatId, text: "x".repeat(4001) })).ok, false);
    assert.equal((await send(alice, { chatId, imageUrl: "https://evil.com/a.png" })).ok, false);
  } finally {
    alice.close();
  }
});

test("bot chat: event marked toBot, stream + final reply reach the user", async () => {
  const chats = await api("alice", "/chats");
  const botChatId = chats.body.find((c) => c.user.isBot).chatId;
  const alice = await connect(tokens.alice);
  try {
    const ack = await send(alice, { chatId: botChatId, text: "How many mice are in stock?" });
    assert.equal(ack.ok, true);
    assert.equal(published.at(-1).value.toBot, true);

    // pretend bot-service answered through Kafka
    const streamed = once(alice, "bot:stream");
    await handleBotEvent(io, "bot.stream", { chatId: botChatId, replyId: "r1", kind: "delta", text: "There are " });
    assert.equal((await streamed).text, "There are ");

    const reply = {
      id: crypto.randomUUID(), chatId: botChatId, senderId: "chatbot",
      text: "There are 42 Wireless Mice in stock.", createdAt: new Date().toISOString(),
      meta: { sql: "SELECT stock FROM products WHERE name ILIKE '%mouse%'" },
    };
    const final = once(alice, "message:new");
    await handleBotEvent(io, "bot.replies", { message: reply });
    assert.equal((await final).message.text, reply.text);

    await saveMessage(reply); // what the persistence worker does
    const history = await api("alice", `/chats/${botChatId}/messages`);
    assert.equal(history.body.at(-1).meta.sql.startsWith("SELECT"), true);
  } finally {
    alice.close();
  }
});

test("saveMessage is idempotent (Kafka may deliver twice)", async () => {
  const m = { id: crypto.randomUUID(), chatId, senderId: `dev-alice${run}`, text: "dup", createdAt: new Date().toISOString() };
  assert.equal(await saveMessage(m), true);
  assert.equal(await saveMessage(m), false);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM messages WHERE id = $1", [m.id]);
  assert.equal(rows[0].n, 1);
});
