import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Served by the API at /admin (src/app.ts), so assets and routes live under it.
// In dev, /admin/api is proxied to the locally running API (PORT 3000).
export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  server: { proxy: { "/admin/api": "http://localhost:3000" } },
});
