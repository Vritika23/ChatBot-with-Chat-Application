/** Round avatar. Falls back to the first letter of the name when there is no photo. */
export default function Avatar({ name = "?", src, size = 40, online }) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {src ? <img src={src} alt="" /> : <span>{name.trim().charAt(0).toUpperCase() || "?"}</span>}
      {online !== undefined && <span className={`dot ${online ? "online" : ""}`} />}
    </span>
  );
}
