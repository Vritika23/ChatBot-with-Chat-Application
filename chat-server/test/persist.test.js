/**
 * Persistence worker: poison messages must go to the dead-letter topic
 * instead of blocking the partition, while temporary errors are retried.
 * Uses the real Postgres (for a real foreign-key error) and a fake publish.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const { persistEvent, isPermanentDbError } = await import("../src/persist.js");
const { pool, saveMessage, upsertUser, getOrCreateChat } = await import("../src/db.js");

const quiet = { log() {}, warn() {} };
const record = (value, offset = "1") => ({
  topic: "chat.messages", partition: 0,
  message: { offset, key: Buffer.from("k"), value: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)) },
});
const deps = () => {
  const dead = [];
  return { dead, save: saveMessage, publish: async (topic, key, value) => dead.push({ topic, value }), log: quiet };
};
const msg = (chatId, extra = {}) => ({ message: { id: randomUUID(), chatId, senderId: "chatbot", text: "hi", createdAt: new Date().toISOString(), ...extra } });

after(() => pool.end());

test("message for a DELETED chat goes to dead.letters instead of blocking forever", async () => {
  const d = deps();
  const result = await persistEvent(record(msg(randomUUID())), d); // chat id that doesn't exist
  assert.equal(result, "dead-lettered");
  assert.equal(d.dead.length, 1);
  assert.equal(d.dead[0].topic, "dead.letters");
  assert.equal(d.dead[0].value.code, "23503"); // foreign key violation
  assert.equal(d.dead[0].value.sourceTopic, "chat.messages");
  assert.match(d.dead[0].value.event, /"text":"hi"/); // the original event is kept for inspection
});

test("broken JSON and events without an id go to dead.letters", async () => {
  const d = deps();
  assert.equal(await persistEvent(record("{not json"), d), "dead-lettered");
  assert.equal(await persistEvent(record({ message: { text: "no id" } }), d), "dead-lettered");
  assert.deepEqual(d.dead.map((x) => x.value.reason), ["not valid JSON", "event has no message.id / message.chatId"]);
});

test("a TEMPORARY database error is thrown (so Kafka retries), not dead-lettered", async () => {
  const d = deps();
  const down = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
  await assert.rejects(persistEvent(record(msg(randomUUID())), { ...d, save: async () => { throw down; } }), /ECONNREFUSED/);
  assert.equal(d.dead.length, 0);
});

test("a good event is saved, and a duplicate is not saved twice", async () => {
  const uid = `persist-test-${Date.now()}`;
  await upsertUser({ uid, name: "Persist Test", email: null, picture: null });
  const chatId = await getOrCreateChat(uid, "chatbot");
  const d = deps();
  const ev = msg(chatId);
  assert.equal(await persistEvent(record(ev), d), "saved");
  assert.equal(await persistEvent(record(ev), d), "duplicate");
  assert.equal(d.dead.length, 0);
  await pool.query("DELETE FROM chats WHERE id = $1", [chatId]);
  await pool.query("DELETE FROM users WHERE id = $1", [uid]);
});

test("error classification", () => {
  assert.ok(isPermanentDbError({ code: "23503" })); // foreign key
  assert.ok(isPermanentDbError({ code: "22P02" })); // invalid uuid text
  assert.ok(!isPermanentDbError({ code: "ECONNREFUSED" }));
  assert.ok(!isPermanentDbError({ code: "57P01" })); // admin shutdown → temporary
  assert.ok(!isPermanentDbError(new Error("x")));
});
