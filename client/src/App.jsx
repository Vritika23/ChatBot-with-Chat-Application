import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Register from "./pages/Register";

function Protected({ children }) {
  const { currentUser } = useAuth();
  if (currentUser === undefined) return <div className="loading">Loading…</div>;
  return currentUser ? children : <Navigate to="/login" replace />;
}

function GuestOnly({ children }) {
  const { currentUser } = useAuth();
  if (currentUser === undefined) return <div className="loading">Loading…</div>;
  return currentUser ? <Navigate to="/" replace /> : children;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Protected><Home /></Protected>} />
        <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
        <Route path="/register" element={<GuestOnly><Register /></GuestOnly>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
