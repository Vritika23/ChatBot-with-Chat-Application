import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword,
  signOut, updateProfile,
} from "firebase/auth";
import { getFirebaseAuth } from "../lib/firebase";
import { setTokenGetter, uploadImage } from "../lib/api";

export const DEV_MODE = import.meta.env.VITE_AUTH_MODE === "dev";

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

// ---------- dev mode: no password, only for local testing ----------
const DEV_KEY = "letschat.devUser";
const readDevUser = () => {
  try {
    return JSON.parse(localStorage.getItem(DEV_KEY));
  } catch {
    return null;
  }
};
const devIdFrom = (name) => name.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);

export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(undefined); // undefined = still loading

  useEffect(() => {
    if (DEV_MODE) {
      const u = readDevUser();
      setCurrentUser(u ? { uid: `dev-${u.id}`, displayName: u.name, photoURL: null } : null);
      return;
    }
    return onAuthStateChanged(getFirebaseAuth(), (u) =>
      setCurrentUser(u ? { uid: u.uid, displayName: u.displayName, photoURL: u.photoURL } : null)
    );
  }, []);

  const getToken = useCallback(async () => {
    if (DEV_MODE) {
      const u = readDevUser();
      return u ? `dev:${u.id}:${u.name}` : null;
    }
    return getFirebaseAuth().currentUser?.getIdToken() ?? null;
  }, []);

  useEffect(() => setTokenGetter(getToken), [getToken]);

  const login = useCallback(async (email, password) => {
    if (DEV_MODE) {
      const name = email.split("@")[0];
      const u = { id: devIdFrom(name), name };
      if (!u.id) throw new Error("Pick a name with letters or numbers");
      localStorage.setItem(DEV_KEY, JSON.stringify(u));
      setCurrentUser({ uid: `dev-${u.id}`, displayName: u.name, photoURL: null });
      return;
    }
    await signInWithEmailAndPassword(getFirebaseAuth(), email, password);
  }, []);

  const register = useCallback(async ({ displayName, email, password, avatar }) => {
    if (DEV_MODE) {
      const u = { id: devIdFrom(displayName), name: displayName };
      localStorage.setItem(DEV_KEY, JSON.stringify(u));
      setCurrentUser({ uid: `dev-${u.id}`, displayName, photoURL: null });
      return;
    }
    const auth = getFirebaseAuth();
    const { user } = await createUserWithEmailAndPassword(auth, email, password);
    let photoURL = null;
    if (avatar) {
      // our own server stores the image (no Firebase Storage / paid plan needed)
      photoURL = window.location.origin + (await uploadImage(avatar));
    }
    await updateProfile(user, { displayName, photoURL });
    await user.getIdToken(true); // refresh so the token carries the new name/photo
    setCurrentUser({ uid: user.uid, displayName, photoURL });
  }, []);

  const logout = useCallback(async () => {
    if (DEV_MODE) {
      localStorage.removeItem(DEV_KEY);
      setCurrentUser(null);
      return;
    }
    await signOut(getFirebaseAuth());
  }, []);

  const value = useMemo(
    () => ({ currentUser, getToken, login, register, logout }),
    [currentUser, getToken, login, register, logout]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
