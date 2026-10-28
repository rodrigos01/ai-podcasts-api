import react from "@vitejs/plugin-react";
import { loadEnv, defineConfig } from "vite";

// Served by the API at /admin (src/app.ts), so assets and routes live under it.
// In dev, /admin/api is proxied to the locally running API.
//
// The Firebase web config comes from the API's own root .env, so there is
// nothing to configure twice: FIREBASE_WEB_API_KEY, FIREBASE_PROJECT_ID and
// FIRESTORE_DATABASE_ID (and PORT, for the proxy). Only these few values are
// exposed to the bundle, by name — never the rest of .env (it holds secrets).
// A VITE_* variable (admin/.env.local, or the Docker build args) takes
// precedence over its .env counterpart.
export default defineConfig(({ mode }) => {
  const root = loadEnv(mode, "..", ""); // the API's .env (plus process env)
  const own = loadEnv(mode, ".", "VITE_");
  const projectId = own.VITE_FIREBASE_PROJECT_ID || root.FIREBASE_PROJECT_ID || "";
  const values = {
    apiKey: own.VITE_FIREBASE_API_KEY || root.FIREBASE_WEB_API_KEY || "",
    authDomain: own.VITE_FIREBASE_AUTH_DOMAIN || (projectId ? `${projectId}.firebaseapp.com` : ""),
    projectId,
    databaseId: own.VITE_FIRESTORE_DATABASE_ID || root.FIRESTORE_DATABASE_ID || "podcasts",
  };

  return {
    base: "/admin/",
    plugins: [react()],
    define: { __FIREBASE_CONFIG__: JSON.stringify(values) },
    server: { proxy: { "/admin/api": `http://localhost:${root.PORT || 3000}` } },
  };
});
