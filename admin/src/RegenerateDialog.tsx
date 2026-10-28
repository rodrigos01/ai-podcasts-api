import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
} from "@mui/material";
import { useState } from "react";

export function RegenerateDialog({
  count,
  onConfirm,
  onClose,
}: {
  count: number;
  onConfirm: (redraft: boolean) => void;
  onClose: () => void;
}) {
  const [redraft, setRedraft] = useState(false);
  return (
    <Dialog open onClose={onClose}>
      <DialogTitle>Regenerate {count} episode{count === 1 ? "" : "s"}?</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Throws away each transcript and its cached audio and writes new scripts. They run one at a time in series
          order (earliest first), because each script is written with the earlier episodes' transcripts as history.
          This spends Gemini quota; if one fails, the ones after it are marked failed.
        </DialogContentText>
        <FormControlLabel
          sx={{ mt: 2 }}
          control={<Checkbox checked={redraft} onChange={(e) => setRedraft(e.target.checked)} />}
          label="Also re-draft: new title, topics, production notes and guest before each script"
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => {
            onConfirm(redraft);
            onClose();
          }}
        >
          Regenerate
        </Button>
      </DialogActions>
    </Dialog>
  );
}
