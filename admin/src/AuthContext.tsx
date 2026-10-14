import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { auth } from "./firebase";

interface AuthState {
  user: User | null;
  isAdmin: boolean;
  loading: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(
    () =>
      onAuthStateChanged(auth, async (next) => {
        // Force a refresh so a freshly granted `admin` claim is picked up on sign-in.
        const claims = next ? (await next.getIdTokenResult(true)).claims : {};
        setUser(next);
        setIsAdmin(claims.admin === true);
        setLoading(false);
      }),
    [],
  );

  const value: AuthState = {
    user,
    isAdmin,
    loading,
    signIn: async () => {
      await signInWithPopup(auth, new GoogleAuthProvider());
    },
    signOut: () => signOut(auth),
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
