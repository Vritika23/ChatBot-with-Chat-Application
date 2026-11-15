import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BOT_ID, useChat } from "../context/ChatContext";
import Message from "./Message";

export default function Messages({ chat }) {
  const { messages, hasMore, loadOlder, botLive } = useChat();
  const list = messages[chat.chatId] || [];
  const live = botLive[chat.chatId];
  const bottomRef = useRef(null);

  // keep the newest message in view
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [list.length, live?.text, live?.status]);

  return (
    <div className="messages">
      {hasMore[chat.chatId] && (
        <button className="loadOlder" onClick={() => loadOlder(chat.chatId)}>Load older messages</button>
      )}
      {list.map((m) => (
        <Message key={m.id} message={m} other={chat.user} />
      ))}

      {/* the bot's answer while it is still being written */}
      {live && (
        <div className="message bot">
          <div className="messageContent">
            {live.text ? (
              <div className="bubble markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{live.text}</ReactMarkdown>
                <span className="cursor">▍</span>
              </div>
            ) : (
              <div className="bubble status">
                <span className="dots"><i /><i /><i /></span> {live.status || "Thinking…"}
              </div>
            )}
          </div>
        </div>
      )}
      {!list.length && !live && (
        <p className="noMessages">
          {chat.user.uid === BOT_ID
            ? "Try: “Which products are low in stock?” or upload a PDF with 📄 and ask about it."
            : "No messages yet. Say hi! 👋"}
        </p>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
