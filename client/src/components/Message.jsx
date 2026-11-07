import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAuth } from "../context/AuthContext";
import { BOT_ID } from "../context/ChatContext";
import Avatar from "./Avatar";

const timeOf = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export default function Message({ message, other }) {
  const { currentUser } = useAuth();
  const mine = message.senderId === currentUser.uid;
  const isBot = message.senderId === BOT_ID;
  const sender = mine ? currentUser : other;
  const meta = message.meta || {};

  return (
    <div className={`message ${mine ? "owner" : ""} ${isBot ? "bot" : ""}`}>
      <div className="messageInfo">
        <Avatar name={sender.displayName} src={sender.photoURL} size={40} />
        <span>{message.pending ? "sending…" : timeOf(message.createdAt)}</span>
      </div>
      <div className="messageContent">
        {message.text && (
          <div className={`bubble ${isBot ? "markdown" : ""}`}>
            {isBot ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown> : message.text}
          </div>
        )}
        {message.imageUrl && <img src={message.imageUrl} alt="" />}
        {message.failed && <span className="failed">⚠ {message.failed}</span>}

        {isBot && meta.sources?.length > 0 && (
          <details className="extra">
            <summary>📄 {meta.sources.length} source(s) from your documents</summary>
            <ol>
              {meta.sources.map((s, i) => (
                <li key={i}>
                  <b>{s.filename}</b>, page {s.page} <small>(match {Math.round(s.score * 100)}%)</small>
                  <div className="snippet">“{s.snippet}…”</div>
                </li>
              ))}
            </ol>
          </details>
        )}
        {isBot && meta.sql && (
          <details className="extra">
            <summary>🗄️ Live data query{meta.sqlError ? " (failed)" : ""}</summary>
            <code>{meta.sql}</code>
            {meta.sqlError && <div className="failed">{meta.sqlError}</div>}
          </details>
        )}
      </div>
    </div>
  );
}
