import { useEffect, useState } from "react";
import { api, uploadBotDocument } from "../lib/api";

/** Upload / list / delete the documents the bot can answer from (RAG). */
export default function BotDocs() {
  const [docs, setDocs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const refresh = () => api("/bot/documents").then(setDocs).catch((e) => setMsg(e.message));
  useEffect(() => {
    refresh();
    // a document uploaded with the attach button (in the input bar) should appear here too
    window.addEventListener("botdocs:changed", refresh);
    return () => window.removeEventListener("botdocs:changed", refresh);
  }, []);

  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    setMsg(`Reading “${file.name}” and creating embeddings…`);
    try {
      const d = await uploadBotDocument(file); // also triggers refresh via "botdocs:changed"
      setMsg(`✅ Added ${d.filename} (${d.numPages} page(s), ${d.numChunks} chunks). Ask me about it!`);
    } catch (e) {
      setMsg(`❌ ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    await api(`/bot/documents/${id}`, { method: "DELETE" }).catch((e) => setMsg(e.message));
    refresh();
  };

  return (
    <div className="botDocs">
      <div className="row">
        <label className={`uploadBtn ${busy ? "disabled" : ""}`}>
          {busy ? "Uploading…" : "+ Upload PDF / TXT / MD"}
          <input
            type="file" accept=".pdf,.txt,.md" disabled={busy} style={{ display: "none" }}
            onChange={(e) => { upload(e.target.files[0]); e.target.value = ""; }}
          />
        </label>
        <small>Only you can see your documents. The bot also knows the live <b>products</b> and <b>orders</b> tables.</small>
      </div>
      {msg && <div className="docMsg">{msg}</div>}
      {docs.length > 0 && (
        <ul>
          {docs.map((d) => (
            <li key={d.id}>
              📄 {d.filename} <small>· {d.numPages} pg · {d.numChunks} chunks</small>
              <button onClick={() => remove(d.id)} title="Delete">✕</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
