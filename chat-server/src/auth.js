import admin from "firebase-admin";
import { config, BOT_USER_ID } from "./config.js";
import { upsertUser, getOrCreateChat } from "./db.js";

let firebaseReady = false;

if (config.authMode === "dev") {
  console.warn(
    "\n⚠️  AUTH_MODE=dev — anyone can log in as anyone. Use only on your own laptop.\n"
  );
}

/**
 * Turns a token from the client into a user.
 * - firebase mode: verifies the Firebase ID token (signature, expiry, project).
 * - dev mode: token looks like "dev:<id>:<name>" (no password, for local testing).
 */
export async function verifyToken(token) {
  if (!token) throw new Error("Missing token");

  if (config.authMode === "dev") {
    const [prefix, rawId, ...nameParts] = token.split(":");
    const id = (rawId || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
    if (prefix !== "dev" || !id) throw new Error("Bad dev token");
    return { uid: `dev-${id}`, name: nameParts.join(":") || id, email: null, picture: null };
  }

  if (!firebaseReady) {
    // Verifying ID tokens only needs the project id (no service account key).
    admin.initializeApp({ projectId: config.firebaseProjectId });
    firebaseReady = true;
  }
  const decoded = await admin.auth().verifyIdToken(token);
  return {
    uid: decoded.uid,
    name: decoded.name || decoded.email?.split("@")[0] || "User",
    email: decoded.email || null,
    picture: decoded.picture || null,
  };
}

// Remember who we synced recently so we don't write to the DB on every request.
const synced = new Map(); // uid -> { at, name, picture }
const RESYNC_MS = 5 * 60 * 1000;

/** Verifies the token and makes sure the user exists in Postgres. */
export async function authenticate(token) {
  const user = await verifyToken(token);
  if (user.uid === BOT_USER_ID) throw new Error("Reserved user id");

  const prev = synced.get(user.uid);
  const changed = !prev || prev.name !== user.name || prev.picture !== user.picture;
  if (changed || Date.now() - prev.at > RESYNC_MS) {
    await upsertUser(user);
    if (!prev) await getOrCreateChat(user.uid, BOT_USER_ID); // everyone gets a ChatBot chat
    synced.set(user.uid, { at: Date.now(), name: user.name, picture: user.picture });
  }
  return user;
}

/** Express middleware: "Authorization: Bearer <token>" → req.user */
export async function httpAuth(req, res, next) {
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    req.user = await authenticate(token);
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
}
