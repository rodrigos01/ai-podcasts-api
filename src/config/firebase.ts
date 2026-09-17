import path from "node:path";
import { applicationDefault, cert, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { env } from "./env";

// Local dev: read the service-account JSON directly so geminiClient.ts can
// reuse the same object for Cloud TTS credentials without a second file
// read. In any deployed environment FIREBASE_SERVICE_ACCOUNT_PATH is left
// unset, `serviceAccount` is undefined, and both this app and Cloud TTS
// fall back to Application Default Credentials (the runtime's attached
// service account) instead — see geminiClient.ts's ttsClient construction.
export const serviceAccount = env.FIREBASE_SERVICE_ACCOUNT_PATH
  ? // eslint-disable-next-line @typescript-eslint/no-var-requires
    require(
      path.isAbsolute(env.FIREBASE_SERVICE_ACCOUNT_PATH)
        ? env.FIREBASE_SERVICE_ACCOUNT_PATH
        : path.join(process.cwd(), env.FIREBASE_SERVICE_ACCOUNT_PATH),
    )
  : undefined;

export const firebaseApp = initializeApp({
  credential: serviceAccount ? cert(serviceAccount) : applicationDefault(),
  projectId: env.FIREBASE_PROJECT_ID,
  storageBucket: env.FIREBASE_STORAGE_BUCKET,
});

export const firestore = getFirestore(firebaseApp, env.FIRESTORE_DATABASE_ID);
export const storageBucket = getStorage(firebaseApp).bucket();
