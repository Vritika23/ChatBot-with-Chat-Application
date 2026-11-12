// Small fetch helper that adds the login token to every request.

let tokenGetter = async () => null;
export const setTokenGetter = (fn) => (tokenGetter = fn);

export async function api(path, { method = "GET", body, form } = {}) {
  const token = await tokenGetter();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.detail || `Request failed (${res.status})`);
  return data;
}

// ---------- documents the bot can read (RAG) ----------

export const DOC_ACCEPT = ".pdf,.txt,.md,application/pdf,text/plain,text/markdown";
export const isDocument = (file) =>
  /\.(pdf|txt|md)$/i.test(file?.name || "") ||
  ["application/pdf", "text/plain", "text/markdown"].includes(file?.type);

/** Uploads a document for the bot and tells any open "My documents" panel to refresh. */
export async function uploadBotDocument(file) {
  const form = new FormData();
  form.append("file", file);
  const doc = await api("/bot/documents", { method: "POST", form });
  window.dispatchEvent(new Event("botdocs:changed"));
  return doc;
}

export async function uploadImage(file) {
  const form = new FormData();
  form.append("file", file);
  const { url } = await api("/uploads", { method: "POST", form });
  return url;
}
