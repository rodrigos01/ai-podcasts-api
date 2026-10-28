import { Router } from "express";
import * as adminBulkController from "../controllers/adminBulk.controller";
import { asyncHandler } from "../middleware/asyncHandler";

// Admin-only operations that have no user-facing equivalent (mounted behind
// requireAdmin in app.ts). Plain bulk deletes and audio resets are just the
// regular per-item routes called in a loop by the admin app.
export const adminBulkRouter = Router();

adminBulkRouter.post("/podcasts/owner", asyncHandler(adminBulkController.changeOwner));
adminBulkRouter.post("/episodes/regenerate", asyncHandler(adminBulkController.regenerateEpisodes));
