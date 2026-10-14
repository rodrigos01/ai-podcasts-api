/**
 * Admin access is a Firebase Auth custom claim, `admin: true`, set by
 * scripts/grant-admin.ts. It rides in the ID token, so checking it needs no
 * database read; a change reaches a signed-in user when their token next
 * refreshes (up to an hour, or on sign-in again).
 */
export const ADMIN_CLAIM = "admin";

export function hasAdminClaim(claims: Record<string, unknown>): boolean {
  return claims[ADMIN_CLAIM] === true;
}

/** The custom claims to store after granting/revoking, keeping any others. */
export function withAdminClaim(existing: Record<string, unknown> | undefined, admin: boolean) {
  const { [ADMIN_CLAIM]: _old, ...rest } = existing ?? {};
  return admin ? { ...rest, [ADMIN_CLAIM]: true } : rest;
}
