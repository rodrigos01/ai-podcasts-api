import express from "express";
import { asyncHandler } from "./middleware/asyncHandler";
import { errorHandler } from "./middleware/errorHandler";
import * as audioController from "./controllers/audio.controller";
import { castCors } from "./middleware/castCors";
import { requireAuth } from "./middleware/requireAuth";
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

  app.use(errorHandler);

  return app;
}
