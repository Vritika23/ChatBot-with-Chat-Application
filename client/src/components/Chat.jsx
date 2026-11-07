import { useState } from "react";
import { useChat } from "../context/ChatContext";
import BotDocs from "./BotDocs";
import Input from "./Input";
import Messages from "./Messages";

export default function Chat() {
  const { selectedChat, online, typing } = useChat();
  const [showDocs, setShowDocs] = useState(false);

  if (!selectedChat) {
    return (
      <div className="chat empty">
        <div className="emptyChat">
          <h2>Welcome to Let's Chat 👋</h2>
          <p>Pick a chat on the left, or search for a friend.</p>
          <p>Open <b>ChatBot 🤖</b> to ask questions about your PDFs or live store data.</p>
        </div>
      </div>
    );
  }

  const { user, chatId } = selectedChat;
  const status = typing[chatId] ? "typing…" : user.isBot ? "AI assistant" : online[user.uid] ? "online" : "offline";

  return (
    <div className="chat">
      <div className="chatInfo">
        <div className="who">
          <span>{user.displayName}</span>
          <small>{status}</small>
        </div>
        {user.isBot && (
          <div className="chatIcons">
            <button className="docsBtn" onClick={() => setShowDocs((s) => !s)}>
              📄 {showDocs ? "Hide documents" : "My documents"}
            </button>
          </div>
        )}
      </div>
      {user.isBot && showDocs && <BotDocs />}
      <Messages chat={selectedChat} />
      <Input chatId={chatId} isBot={user.isBot} />
    </div>
  );
}
