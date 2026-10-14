import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, type ButtonProps } from "@mui/material";
import { useState } from "react";

/** A button that asks for confirmation before running `onConfirm`. */
export function ConfirmButton({
  title,
  message,
  onConfirm,
  children,
  ...buttonProps
}: { title: string; message: string; onConfirm: () => void } & Omit<ButtonProps, "onClick" | "title">) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button {...buttonProps} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)}>
        <DialogTitle>{title}</DialogTitle>
        <DialogContent>
          <DialogContentText>{message}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            color={buttonProps.color ?? "primary"}
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            Confirm
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
