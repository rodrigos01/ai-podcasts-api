import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

export const firebaseApp = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
});

export const auth = getAuth(firebaseApp);
// The API uses a named database, not "(default)". Reads go straight to it;
// firebase.rules lets admins (the `admin` custom claim) read everything.
export const db = getFirestore(firebaseApp, import.meta.env.VITE_FIRESTORE_DATABASE_ID || "podcasts");
