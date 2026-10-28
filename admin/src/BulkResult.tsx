import { Alert } from "@mui/material";
import type { BulkOutcome } from "./bulk";

export function BulkResult({ outcome, onClose }: { outcome: BulkOutcome | null; onClose: () => void }) {
  if (!outcome) return null;
  const failed = outcome.failures.length;
  return (
    <Alert severity={failed ? "warning" : "success"} onClose={onClose} sx={{ mb: 2 }}>
      {outcome.label}: {outcome.done} succeeded{failed ? `, ${failed} failed` : ""}.
      {outcome.failures.map((f) => (
        <div key={f.id}>
          <code>{f.id}</code>: {f.message}
        </div>
      ))}
    </Alert>
  );
}
