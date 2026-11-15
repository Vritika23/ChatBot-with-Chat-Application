import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useChat } from "../context/ChatContext";
import { api } from "../lib/api";
import Avatar from "./Avatar";

export default function Sidebar() {
  return (
    <div className="sidebar">
      <Navbar />
      <Search />
      <Chats />
    </div>
  );
}

function Navbar() {
  const { currentUser, logout } = useAuth();
  const { connected } = useChat();
  return (
    <div className="navbar">
      <span className="logo">
        Let's Chat <span className={`conn ${connected ? "on" : ""}`} title={connected ? "Connected" : "Reconnecting…"} />
      </span>
      <div className="user">
        <Avatar name={currentUser.displayName} src={currentUser.photoURL} size={24} />
        <span>{currentUser.displayName}</span>
        <button onClick={logout}>logout</button>
      </div>
    </div>
  );
}

function Search() {
  const { openChatWith } = useChat();
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [err, setErr] = useState("");

  // search while typing (waits 300 ms after the last key press)
  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      setErr("");
      return;
    }
    const t = setTimeout(async () => {
      try {
        const users = await api(`/users/search?q=${encodeURIComponent(q.trim())}`);
        setResults(users);
        setErr(users.length ? "" : "No user found");
      } catch (e) {
        setErr(e.message);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const pick = async (u) => {
    setQ("");
    await openChatWith(u.uid);
  };

  return (
    <div className="search">
      <div className="searchForm">
        <input type="text" placeholder="Find a user" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {err && <span className="searchErr">{err}</span>}
      {results.map((u) => (
        <div className="userChat" key={u.uid} onClick={() => pick(u)}>
          <Avatar name={u.displayName} src={u.photoURL} size={50} />
          <div className="userChatInfo">
            <span>{u.displayName}{u.isBot && " 🤖"}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function Chats() {
  const { chats, selectedChat, selectChat, online, typing } = useChat();
  return (
    <div className="chats">
      {chats.map((c) => (
        <div
          key={c.chatId}
          className={`userChat ${selectedChat?.chatId === c.chatId ? "active" : ""}`}
          onClick={() => selectChat(c.chatId)}
        >
          <Avatar name={c.user.displayName} src={c.user.photoURL} size={50} online={online[c.user.uid]} />
          <div className="userChatInfo">
            <span>{c.user.displayName}{c.user.isBot && " 🤖"}</span>
            <p>{typing[c.chatId] ? <i>typing…</i> : c.lastMessage || (c.user.isBot ? "Ask me anything!" : "Say hi 👋")}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
