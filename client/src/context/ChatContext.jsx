/**
 * All live chat state lives here:
 *  - one Socket.IO connection (logged in with the user's token)
 *  - chat list, messages per chat, who is online, who is typing
 *  - the bot's live "streaming" answer per chat
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { api, uploadImage } from "../lib/api";
import { useAuth } from "./AuthContext";

const ChatContext = createContext(null);
export const useChat = () => useContext(ChatContext);

export const BOT_ID = "chatbot";

export function ChatProvider({ children }) {
  const { currentUser, getToken } = useAuth();
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);

  const [chats, setChats] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [messages, setMessages] = useState({}); // chatId -> [message]
  const [hasMore, setHasMore] = useState({});   // chatId -> bool
  const [online, setOnline] = useState({});     // userId -> bool
  const [typing, setTyping] = useState({});     // chatId -> bool
  const [botLive, setBotLive] = useState({});   // chatId -> { status, text }

  const typingTimers = useRef({});
  const chatsRef = useRef(chats);
  chatsRef.current = chats;

  const loadChats = useCallback(async () => {
    const list = await api("/chats");
    setChats(list);
    socketRef.current?.emit("presence:query", list.map((c) => c.user.uid), (res) =>
      setOnline((o) => ({ ...o, ...Object.fromEntries(res.map((p) => [p.userId, p.online])) }))
    );
    return list;
  }, []);

  // ---------- socket connection + listeners ----------
  useEffect(() => {
    if (!currentUser) return;

    const socket = io({
      // a function → a fresh token is sent on every (re)connect
      auth: (cb) => getToken().then((token) => cb({ token })),
      transports: ["websocket"],
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      loadChats().catch(console.error);
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", (e) => console.warn("socket:", e.message));

    socket.on("message:new", ({ message }) => {
      addMessage(message);
      if (message.senderId === BOT_ID) setBotLive((b) => ({ ...b, [message.chatId]: null }));
      setChats((list) => {
        const i = list.findIndex((c) => c.chatId === message.chatId);
        if (i === -1) {
          loadChats(); // a brand-new chat someone started with us
          return list;
        }
        const updated = {
          ...list[i],
          lastMessage: message.text || "📷 Photo",
          lastMessageAt: message.createdAt,
        };
        return [updated, ...list.filter((_, j) => j !== i)];
      });
    });

    socket.on("bot:stream", ({ chatId, kind, text }) =>
      setBotLive((b) => {
        const cur = b[chatId] || { status: "", text: "" };
        return {
          ...b,
          [chatId]: kind === "delta" ? { status: "", text: cur.text + text } : { ...cur, status: text },
        };
      })
    );

    socket.on("typing", ({ chatId, isTyping }) => {
      // someone started a new chat with us and is typing the first message
      if (!chatsRef.current.some((c) => c.chatId === chatId)) loadChats();
      clearTimeout(typingTimers.current[chatId]);
      setTyping((t) => ({ ...t, [chatId]: isTyping }));
      if (isTyping) {
        typingTimers.current[chatId] = setTimeout(
          () => setTyping((t) => ({ ...t, [chatId]: false })), 4000
        );
      }
    });

    socket.on("presence:update", ({ userId, online: isOnline }) =>
      setOnline((o) => ({ ...o, [userId]: isOnline }))
    );

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setChats([]);
      setMessages({});
      setSelectedId(null);
    };
  }, [currentUser, getToken, loadChats]);

  /** Adds a message, ignoring duplicates (same id) and replacing our temp copy. */
  function addMessage(message, tempId) {
    setMessages((all) => {
      const list = all[message.chatId];
      if (!list) return all; // chat not opened yet — it will load from the server
      if (list.some((m) => m.id === message.id)) {
        return tempId ? { ...all, [message.chatId]: list.filter((m) => m.id !== tempId) } : all;
      }
      const withoutTemp = tempId ? list.filter((m) => m.id !== tempId) : list;
      return { ...all, [message.chatId]: [...withoutTemp, message] };
    });
  }

  // ---------- actions ----------
  const selectChat = useCallback(async (chatId) => {
    setSelectedId(chatId);
    if (messages[chatId]) return;
    const list = await api(`/chats/${chatId}/messages?limit=50`);
    setMessages((all) => ({ ...all, [chatId]: mergeById(list, all[chatId] || []) }));
    setHasMore((h) => ({ ...h, [chatId]: list.length === 50 }));
  }, [messages]);

  const loadOlder = useCallback(async (chatId) => {
    const first = messages[chatId]?.[0];
    if (!first) return;
    const older = await api(`/chats/${chatId}/messages?limit=50&before=${encodeURIComponent(first.createdAt)}`);
    setMessages((all) => ({ ...all, [chatId]: [...older, ...(all[chatId] || [])] }));
    setHasMore((h) => ({ ...h, [chatId]: older.length === 50 }));
  }, [messages]);

  const openChatWith = useCallback(async (userId) => {
    const chat = await api("/chats", { method: "POST", body: { userId } });
    setChats((list) => (list.some((c) => c.chatId === chat.chatId) ? list : [chat, ...list]));
    socketRef.current?.emit("presence:query", [userId], (res) =>
      setOnline((o) => ({ ...o, ...Object.fromEntries(res.map((p) => [p.userId, p.online])) }))
    );
    await selectChat(chat.chatId);
  }, [selectChat]);

  const sendMessage = useCallback(async (chatId, text, imageFile) => {
    const tempId = `temp-${Date.now()}`;
    const preview = imageFile ? URL.createObjectURL(imageFile) : null;
    // optimistic UI: show the message right away, mark it "sending"
    setMessages((all) => ({
      ...all,
      [chatId]: [...(all[chatId] || []), {
        id: tempId, chatId, senderId: currentUser.uid, text, imageUrl: preview,
        createdAt: new Date().toISOString(), pending: true,
      }],
    }));
    try {
      const imageUrl = imageFile ? await uploadImage(imageFile) : null;
      const ack = await new Promise((resolve) =>
        socketRef.current.timeout(10000).emit("message:send", { chatId, text, imageUrl }, (err, res) =>
          resolve(err ? { ok: false, error: "Server did not answer. Check your connection." } : res)
        )
      );
      if (!ack.ok) throw new Error(ack.error);
      addMessage(ack.message, tempId);
    } catch (err) {
      setMessages((all) => ({
        ...all,
        [chatId]: all[chatId].map((m) => (m.id === tempId ? { ...m, pending: false, failed: err.message } : m)),
      }));
    }
  }, [currentUser]);

  const lastTypingSent = useRef(0);
  const sendTyping = useCallback((chatId, isTyping) => {
    const now = Date.now();
    if (isTyping && now - lastTypingSent.current < 2000) return; // throttle
    lastTypingSent.current = isTyping ? now : 0;
    socketRef.current?.emit("typing", { chatId, isTyping });
  }, []);

  const selectedChat = chats.find((c) => c.chatId === selectedId) || null;

  const value = useMemo(() => ({
    connected, chats, selectedChat, messages, hasMore, online, typing, botLive,
    selectChat, loadOlder, openChatWith, sendMessage, sendTyping, loadChats,
  }), [connected, chats, selectedChat, messages, hasMore, online, typing, botLive,
       selectChat, loadOlder, openChatWith, sendMessage, sendTyping, loadChats]);

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

function mergeById(a, b) {
  const seen = new Set(a.map((m) => m.id));
  return [...a, ...b.filter((m) => !seen.has(m.id) && !m.pending)];
}
