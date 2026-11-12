/**
 * What the persistence worker does with ONE Kafka event, kept separate from
 * the Kafka wiring so it can be unit-tested.
 *
 * Two kinds of failure are handled differently:
 *  - TEMPORARY (DB down, connection lost, timeout): throw → kafkajs does not
 *    commit the offset and retries the same event. Nothing is ever skipped.
 *  - PERMANENT (the event itself can never be saved: its chat was deleted,
 *    a bad id, broken JSON, missing fields): retrying would loop FOREVER and
 *    block every later message in that partition (a "poison message").
 *    So we move it to the dead-letter topic with the reason, and carry on.
 */
import { TOPICS } from "./config.js";

/**
 * Postgres error classes that mean "this data can never be stored":
 *   22xxx data exception (e.g. 22P02 invalid uuid, 22007 bad date)
 *   23xxx integrity constraint violation (e.g. 23503 foreign key: chat/user gone)
 * Everything else (connection refused, 57P01 admin shutdown, 53300 too many
 * connections, ...) is treated as temporary.
 */
export function isPermanentDbError(err) {
  return typeof err?.code === "string" && /^(22|23)/.test(err.code);
}

/**
 * @param {{topic: string, partition: number, message: {offset: string, key?: Buffer, value: Buffer}}} record
 * @param {{save: Function, publish: Function, log?: Function}} deps
 * @returns {"saved" | "duplicate" | "dead-lettered"}
 */
export async function persistEvent({ topic, partition, message }, { save, publish, log = console }) {
  const where = `${topic}[${partition}]@${message.offset}`;
  const deadLetter = async (reason, code, raw) => {
    await publish(TOPICS.DEAD_LETTERS, message.key?.toString() || null, {
      sourceTopic: topic, partition, offset: message.offset,
      reason, code: code || null, event: raw, failedAt: new Date().toISOString(),
    });
    log.warn(`☠️  moved ${where} to ${TOPICS.DEAD_LETTERS}: ${reason}`);
    return "dead-lettered";
  };

  const raw = message.value?.toString() ?? "";
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return deadLetter("not valid JSON", null, raw);
  }
  if (!event?.message?.id || !event.message.chatId) {
    return deadLetter("event has no message.id / message.chatId", null, raw);
  }

  try {
    const inserted = await save(event.message);
    if (inserted) log.log(`saved ${topic} ${event.message.id}`);
    return inserted ? "saved" : "duplicate";
  } catch (err) {
    if (isPermanentDbError(err)) {
      return deadLetter(`${err.message}${err.detail ? ` (${err.detail})` : ""}`, err.code, raw);
    }
    throw err; // temporary → kafkajs retries this same event, nothing is skipped
  }
}
