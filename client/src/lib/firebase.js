import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

// Values come from .env (VITE_FIREBASE_*). These are public web-app settings,
// but keeping them in .env means each developer can use their own project.
let auth = null;

export function getFirebaseAuth() {
  if (!auth) {
    const app = initializeApp({
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID,
    });
    auth = getAuth(app);
  }
  return auth;
}
