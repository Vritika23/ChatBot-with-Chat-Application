// Small fetch helper that adds the login token to every request.

let tokenGetter = async () => null;
export const setTokenGetter = (fn) => (tokenGetter = fn);

export async function api(path, { method = "GET", body, form } = {}) {
  const token = await tokenGetter();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.detail || `Request failed (${res.status})`);
  return data;
}

export async function uploadImage(file) {
  const form = new FormData();
  form.append("file", file);
  const { url } = await api("/uploads", { method: "POST", form });
  return url;
}
