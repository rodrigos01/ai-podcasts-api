import { Router } from "express";
import { VOICES } from "../constants/voices";
import * as voicesController from "../controllers/voices.controller";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireAuth } from "../middleware/requireAuth";

export const voicesRouter = Router();

voicesRouter.get("/voices", (_req, res) => {
  res.json(VOICES);
});

voicesRouter.get("/voices/:voiceId/preview", asyncHandler(voicesController.preview));

// Billed Voice Design calls, so unlike the rest of /voices this needs auth.
voicesRouter.post("/voices/design", asyncHandler(requireAuth), asyncHandler(voicesController.design));
