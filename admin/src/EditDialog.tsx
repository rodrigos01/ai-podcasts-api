import { Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField } from "@mui/material";
import { useState } from "react";

export interface EditField {
  key: string;
  label: string;
  multiline?: boolean;
}

/** Edits a flat set of text fields; calls `onSave` with the changed values. */
export function EditDialog({
  title,
  fields,
  values,
  onSave,
  onClose,
}: {
  title: string;
  fields: EditField[];
  values: Record<string, string>;
  onSave: (changes: Record<string, string>) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(values);
  return (
    <Dialog open fullWidth maxWidth="md" onClose={onClose}>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent sx={{ display: "grid", gap: 2, pt: "8px !important" }}>
        {fields.map((f) => (
          <TextField
            key={f.key}
            label={f.label}
            value={draft[f.key] ?? ""}
            multiline={f.multiline}
            minRows={f.multiline ? 3 : undefined}
            onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
          />
        ))}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => {
            const changes = Object.fromEntries(fields.filter((f) => draft[f.key] !== values[f.key]).map((f) => [f.key, draft[f.key] ?? ""]));
            if (Object.keys(changes).length > 0) onSave(changes);
            onClose();
          }}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
