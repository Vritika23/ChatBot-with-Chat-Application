import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development, Vite forwards API + socket calls to the chat-server,
// so the browser only ever talks to one origin (no CORS headaches).
const target = process.env.CHAT_SERVER_URL || "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": target,
      "/uploads": target,
      "/socket.io": { target, ws: true },
    },
  },
});
