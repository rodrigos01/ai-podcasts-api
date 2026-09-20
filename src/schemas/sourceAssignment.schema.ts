import { z } from "zod";

export const sourceAssignmentDraftSchema = z.object({
  assignments: z.array(
    z.object({
      sourceId: z.string().min(1),
      speakerIds: z.array(z.string().min(1)).min(1),
    }),
  ),
});

export type SourceAssignmentDraft = z.infer<typeof sourceAssignmentDraftSchema>;
