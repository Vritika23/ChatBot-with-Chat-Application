import { useState } from "react";
import { Link } from "react-router-dom";
import Add from "../assets/addAvatar.png";
import { useAuth } from "../context/AuthContext";
import { friendlyError } from "./Login";

export default function Register() {
  const { register } = useAuth();
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [avatarName, setAvatarName] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const avatar = form.get("avatar");
    setErr("");
    setLoading(true);
    try {
      await register({
        displayName: String(form.get("displayName")).trim(),
        email: String(form.get("email")).trim(),
        password: String(form.get("password")),
        avatar: avatar && avatar.size ? avatar : null,
      });
    } catch (error) {
      setErr(friendlyError(error));
      setLoading(false);
    }
  };

  return (
    <div className="formContainer">
      <div className="formWrapper">
        <span className="logo">Let's Chat</span>
        <span className="title">Register</span>
        <form onSubmit={handleSubmit}>
          <input name="displayName" required maxLength={40} type="text" placeholder="display name" />
          <input name="email" required type="email" placeholder="email" />
          <input name="password" required minLength={6} type="password" placeholder="password" />
          <input
            name="avatar" style={{ display: "none" }} type="file" id="avatar" accept="image/*"
            onChange={(e) => setAvatarName(e.target.files[0]?.name || "")}
          />
          <label htmlFor="avatar">
            <img src={Add} alt="" />
            <span>{avatarName || "Add an avatar (optional)"}</span>
          </label>
          <button disabled={loading}>{loading ? "Creating account…" : "Sign up"}</button>
          {err && <span className="error">{err}</span>}
        </form>
        <p>
          You do have an account? <Link to="/login">Login</Link>
        </p>
      </div>
    </div>
  );
}
