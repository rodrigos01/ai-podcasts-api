import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

export const firebaseApp = initializeApp({
  apiKey: __FIREBASE_CONFIG__.apiKey,
  authDomain: __FIREBASE_CONFIG__.authDomain,
  projectId: __FIREBASE_CONFIG__.projectId,
});

export const auth = getAuth(firebaseApp);
// The API uses a named database, not "(default)". Reads go straight to it;
// firebase.rules lets admins (the `admin` custom claim) read everything.
export const db = getFirestore(firebaseApp, __FIREBASE_CONFIG__.databaseId);
