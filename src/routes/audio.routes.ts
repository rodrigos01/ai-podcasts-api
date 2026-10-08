import { Router } from "express";
import * as audioController from "../controllers/audio.controller";
import { asyncHandler } from "../middleware/asyncHandler";

export const audioRouter = Router({ mergeParams: true });

audioRouter.get("/stream", asyncHandler(audioController.stream));
audioRouter.delete("/", asyncHandler(audioController.clear));
