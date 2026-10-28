import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import { asyncHandler } from "./middleware/asyncHandler";
import { errorHandler } from "./middleware/errorHandler";
import * as audioController from "./controllers/audio.controller";
import { castCors } from "./middleware/castCors";
import { requireAdmin } from "./middleware/requireAdmin";
import { requireAuth } from "./middleware/requireAuth";
import { adminBulkRouter } from "./routes/adminBulk.routes";
import { healthRouter } from "./routes/health.routes";
import { podcastsRouter } from "./routes/podcasts.routes";
import { voicesRouter } from "./routes/voices.routes";

export function createApp() {
  const app = express();

  // Behind Cloud Run's TLS-terminating proxy: lets req.protocol be "https",
  // which the absolute voice preview URLs depend on.
  app.set("trust proxy", true);

  app.use(express.json());
  app.use(healthRouter);
  app.use(voicesRouter);
  // Public on purpose: the signed URL GET /podcasts/:id/episodes/:id/audio/url
  // hands out, which a cast receiver (no way to send a token) fetches directly.
  // The token in the path is the authorization (see utils/audioUrl.ts).
  app.use("/stream", castCors);
  app.get("/stream/:token", asyncHandler(audioController.publicAudio));
  app.use("/podcasts", asyncHandler(requireAuth), podcastsRouter);
  // The same router for admins: requireAdmin lifts the ownership check
  // (services/podcastAccess.ts's requireAccessiblePodcast) and the list
  // returns every user's podcasts.
  app.use("/admin/api/podcasts", asyncHandler(requireAuth), requireAdmin, podcastsRouter);
  app.use("/admin/api/bulk", asyncHandler(requireAuth), requireAdmin, adminBulkRouter);

  // The admin SPA (admin/, built by the Dockerfile), served at /admin. Public
  // files with nothing in them: all data comes through /admin/api above, which
  // needs an admin ID token. Unknown /admin/* paths fall back to index.html for
  // client-side routing. Absent in a checkout where admin/ hasn't been built.
  const adminDist = path.join(__dirname, "..", "admin", "dist");
  if (existsSync(adminDist)) {
    app.use("/admin", express.static(adminDist));
    app.get(/^\/admin(?!\/(api|assets)(\/|$))(\/.*)?$/, (_req, res) => {
      res.sendFile(path.join(adminDist, "index.html"));
    });
  }

  app.use(errorHandler);

  return app;
}
