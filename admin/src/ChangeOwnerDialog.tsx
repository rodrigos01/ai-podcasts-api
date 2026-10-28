import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, TextField } from "@mui/material";
import { useState } from "react";

export function ChangeOwnerDialog({
  count,
  onConfirm,
  onClose,
}: {
  count: number;
  onConfirm: (ownerId: string) => void;
  onClose: () => void;
}) {
  const [ownerId, setOwnerId] = useState("");
  return (
    <Dialog open fullWidth maxWidth="sm" onClose={onClose}>
      <DialogTitle>Change owner of {count} podcast{count === 1 ? "" : "s"}</DialogTitle>
      <DialogContent>
        <DialogContentText>The new owner's Firebase uid (it must be an existing user).</DialogContentText>
        <TextField autoFocus fullWidth sx={{ mt: 2 }} label="Owner uid" value={ownerId} onChange={(e) => setOwnerId(e.target.value.trim())} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!ownerId}
          onClick={() => {
            onConfirm(ownerId);
            onClose();
          }}
        >
          Change owner
        </Button>
      </DialogActions>
    </Dialog>
  );
}
