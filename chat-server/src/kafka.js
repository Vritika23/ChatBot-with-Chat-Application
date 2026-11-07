import { Kafka, Partitioners, logLevel } from "kafkajs";
import { config, TOPICS } from "./config.js";

export const kafka = new Kafka({
  clientId: `chat-server-${config.instanceId}`,
  brokers: config.kafkaBrokers,
  logLevel: logLevel.WARN,
  retry: { initialRetryTime: 300, retries: 10 },
});

// If a retry makes Kafka store an event twice, that's OK: every message has a
// unique id and the database ignores duplicates (INSERT ... ON CONFLICT DO NOTHING).
export const producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });

/** Creates our topics if they don't exist yet (3 partitions each). */
export async function ensureTopics() {
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: Object.values(TOPICS).map((topic) => ({ topic, numPartitions: 3 })),
    });
  } finally {
    await admin.disconnect();
  }
}

/**
 * Publishes one event. The key is the chatId, so all events of one chat go
 * to the same partition → they stay in order.
 */
export async function publish(topic, key, value) {
  await producer.send({
    topic,
    acks: -1, // wait until the broker has safely stored it
    messages: [{ key, value: JSON.stringify(value) }],
  });
}
