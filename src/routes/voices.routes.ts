import { Router } from "express";
import { VOICES } from "../constants/voices";
import * as voicesController from "../controllers/voices.controller";
import { asyncHandler } from "../middleware/asyncHandler";

export const voicesRouter = Router();

voicesRouter.get("/voices", (_req, res) => {
  res.json(VOICES);
});

voicesRouter.get("/voices/:voiceId/preview", asyncHandler(voicesController.preview));
