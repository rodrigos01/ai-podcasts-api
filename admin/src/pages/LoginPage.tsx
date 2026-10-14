import { Alert, Box, Button, Paper, Typography } from "@mui/material";
import { useState } from "react";
import { useAuth } from "../AuthContext";

export function LoginPage() {
  const { user, signIn, signOut } = useAuth();
  const [error, setError] = useState<string | null>(null);

  return (
    <Box sx={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
      <Paper sx={{ p: 4, width: 360, display: "grid", gap: 2 }}>
        <Typography variant="h5">AI Podcasts Admin</Typography>
        {user && <Alert severity="error">{user.email} doesn't have admin access.</Alert>}
        {error && <Alert severity="error">{error}</Alert>}
        {user ? (
          <Button variant="outlined" onClick={() => void signOut()}>
            Sign out
          </Button>
        ) : (
          <Button variant="contained" onClick={() => signIn().catch((e: Error) => setError(e.message))}>
            Sign in with Google
          </Button>
        )}
      </Paper>
    </Box>
  );
}
