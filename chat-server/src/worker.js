/**
 * Persistence worker
 * ------------------
 * Reads every chat message and every final bot reply from Kafka and saves it
 * to Postgres. Because it is a separate consumer group ("persistence"):
 *  - the chat server never waits for the database when you send a message
 *  - if this worker or Postgres is down, nothing is lost: Kafka keeps the
 *    events and the worker continues from its last committed offset.
 * saveMessage() is idempotent, so re-reading an event never makes duplicates.
 */
import { kafka } from "./kafka.js";
import { TOPICS } from "./config.js";
import { pool, saveMessage } from "./db.js";

const consumer = kafka.consumer({ groupId: "persistence" });

async function main() {
  await pool.query("SELECT 1");
  await consumer.connect();
  await consumer.subscribe({ topics: [TOPICS.CHAT_MESSAGES, TOPICS.BOT_REPLIES], fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      let event;
      try {
        event = JSON.parse(message.value.toString());
      } catch {
        console.error(`Skipping bad JSON at ${topic}[${partition}]@${message.offset}`);
        return;
      }
      // If this throws (e.g. DB down), kafkajs does NOT commit the offset and
      // retries the same message — so it is never skipped.
      const inserted = await saveMessage(event.message);
      if (inserted) console.log(`saved ${topic} ${event.message.id}`);
    },
  });
  console.log("🗄️  persistence worker running");
}

const shutdown = async () => {
  await consumer.disconnect().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  console.error("Worker failed:", err);
  process.exit(1);
});
