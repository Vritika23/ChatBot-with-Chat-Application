/**
 * Persistence worker
 * ------------------
 * Reads every chat message and every final bot reply from Kafka and saves it
 * to Postgres. Because it is a separate consumer group ("persistence"):
 *  - the chat server never waits for the database when you send a message
 *  - if this worker or Postgres is down, nothing is lost: Kafka keeps the
 *    events and the worker continues from its last committed offset.
 * saveMessage() is idempotent, so re-reading an event never makes duplicates.
 * Events that can NEVER be saved (e.g. their chat was deleted) go to the
 * dead.letters topic instead of blocking the partition forever.
 */
import { kafka, producer, publish, ensureTopics } from "./kafka.js";
import { TOPICS } from "./config.js";
import { pool, saveMessage } from "./db.js";
import { persistEvent } from "./persist.js";

const consumer = kafka.consumer({ groupId: "persistence" });

async function main() {
  await pool.query("SELECT 1");
  await ensureTopics();      // includes the dead-letter topic
  await producer.connect();  // used only to move un-saveable events to dead.letters
  await consumer.connect();
  await consumer.subscribe({ topics: [TOPICS.CHAT_MESSAGES, TOPICS.BOT_REPLIES], fromBeginning: true });

  await consumer.run({
    // Temporary errors (DB down) are thrown → kafkajs retries, nothing is skipped.
    // Permanent errors (chat deleted, bad data) → dead.letters, then move on,
    // so one bad event can never block the whole partition. See persist.js.
    eachMessage: (record) => persistEvent(record, { save: saveMessage, publish }),
  });
  console.log("🗄️  persistence worker running");
}

const shutdown = async () => {
  await consumer.disconnect().catch(() => {});
  await producer.disconnect().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("Worker failed:", err);
  process.exit(1);
});
