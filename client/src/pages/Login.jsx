import { useState } from "react";
import { Link } from "react-router-dom";
import { DEV_MODE, useAuth } from "../context/AuthContext";

export default function Login() {
  const { login } = useAuth();
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setErr("");
    setLoading(true);
    try {
      await login(String(form.get("email")), String(form.get("password") || ""));
    } catch (error) {
      setErr(friendlyError(error));
      setLoading(false);
    }
  };

  return (
    <div className="formContainer">
      <div className="formWrapper">
        <span className="logo">Let's Chat</span>
        <span className="title">Login</span>
        {DEV_MODE && <span className="devNote">Dev mode: type any name, no password needed</span>}
        <form onSubmit={handleSubmit}>
          <input name="email" required type={DEV_MODE ? "text" : "email"} placeholder={DEV_MODE ? "your name" : "email"} />
          {!DEV_MODE && <input name="password" required type="password" placeholder="password" />}
          <button disabled={loading}>{loading ? "Signing in…" : "Sign in"}</button>
          {err && <span className="error">{err}</span>}
        </form>
        {!DEV_MODE && (
          <p>
            You don't have an account? <Link to="/register">Register</Link>
          </p>
        )}
      </div>
    </div>
  );
}

export function friendlyError(error) {
  const code = error?.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password")) return "Wrong email or password.";
  if (code.includes("email-already-in-use")) return "This email already has an account.";
  if (code.includes("weak-password")) return "Password should be at least 6 characters.";
  if (code.includes("too-many-requests")) return "Too many tries. Please wait a minute.";
  return error?.message || "Something went wrong.";
}
