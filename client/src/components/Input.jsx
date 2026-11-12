import { useEffect, useRef, useState } from "react";
import Img from "../assets/img.png";
import { useChat } from "../context/ChatContext";
import { DOC_ACCEPT, isDocument, uploadBotDocument } from "../lib/api";

const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

export default function Input({ chatId, isBot }) {
  const { sendMessage, sendTyping } = useChat();
  const [text, setText] = useState("");
  const [img, setImg] = useState(null);
  // status of a document upload in the ChatBot chat: { kind: "busy" | "ok" | "error", text }
  const [note, setNote] = useState(null);
  const hideTimer = useRef(null);

  useEffect(() => () => clearTimeout(hideTimer.current), []);
  useEffect(() => setNote(null), [chatId]); // don't carry a note over to another chat

  const handleSend = () => {
    if (!text.trim() && !img) return;
    sendMessage(chatId, text.trim(), img);
    sendTyping(chatId, false);
    setText("");
    setImg(null);
  };

  // In the ChatBot chat, the attach button also takes PDF / TXT / MD files:
  // they are uploaded straight to "My documents" so the bot can answer from them.
  const uploadDocument = async (file) => {
    clearTimeout(hideTimer.current);
    setNote({ kind: "busy", text: `Reading “${file.name}” and creating embeddings…` });
    try {
      const d = await uploadBotDocument(file);
      setNote({ kind: "ok", text: `✅ Added ${d.filename} (${d.numPages} page(s)). Ask me anything about it!` });
      hideTimer.current = setTimeout(() => setNote(null), 8000);
    } catch (e) {
      setNote({ kind: "error", text: `❌ ${e.message}` });
    }
  };

  const onPick = (e) => {
    const file = e.target.files[0] || null;
    e.target.value = ""; // so picking the same file again still triggers onChange
    if (!file) return;
    if (isBot && isDocument(file)) uploadDocument(file);
    else setImg(file);
  };

  return (
    <>
      {note && (
        <div className={`uploadNote ${note.kind}`} role="status">
          {note.kind === "busy" && <span className="dots"><i /><i /><i /></span>}
          <span>{note.text}</span>
          {note.kind !== "busy" && <button onClick={() => setNote(null)} title="Close">✕</button>}
        </div>
      )}
      <div className="input">
        <input
          type="text"
          placeholder={isBot ? "Ask ChatBot something…" : "Type something…"}
          value={text}
          maxLength={4000}
          onChange={(e) => {
            setText(e.target.value);
            if (!isBot) sendTyping(chatId, e.target.value.length > 0);
          }}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
        />
        <div className="send">
          {img && <span className="fileChip" title={img.name}>📷 {img.name.slice(0, 14)}</span>}
          <input
            type="file" style={{ display: "none" }} id={`file-${chatId}`}
            accept={isBot ? `${IMAGE_ACCEPT},${DOC_ACCEPT}` : IMAGE_ACCEPT}
            disabled={note?.kind === "busy"}
            onChange={onPick}
          />
          <label
            htmlFor={`file-${chatId}`}
            title={isBot ? "Upload a PDF / TXT / MD for me to read, or send a picture" : "Send a picture"}
          >
            <img src={Img} alt="attach" />
          </label>
          <button onClick={handleSend}>Send</button>
        </div>
      </div>
    </>
  );
}
