import { useState } from "react";
import Img from "../assets/img.png";
import { useChat } from "../context/ChatContext";

export default function Input({ chatId, isBot }) {
  const { sendMessage, sendTyping } = useChat();
  const [text, setText] = useState("");
  const [img, setImg] = useState(null);

  const handleSend = () => {
    if (!text.trim() && !img) return;
    sendMessage(chatId, text.trim(), img);
    sendTyping(chatId, false);
    setText("");
    setImg(null);
  };

  return (
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
          type="file" style={{ display: "none" }} id={`file-${chatId}`} accept="image/png,image/jpeg,image/gif,image/webp"
          onChange={(e) => setImg(e.target.files[0] || null)}
        />
        <label htmlFor={`file-${chatId}`} title="Send a picture">
          <img src={Img} alt="attach" />
        </label>
        <button onClick={handleSend}>Send</button>
      </div>
    </div>
  );
}
