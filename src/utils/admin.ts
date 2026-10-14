/** Parses the ADMIN_UIDS env value: comma-separated Firebase uids. */
export function parseAdminUids(raw: string): string[] {
  return raw
    .split(",")
    .map((uid) => uid.trim())
    .filter(Boolean);
}

export function isAdminUid(uid: string | undefined, allowlist: readonly string[]): boolean {
  return !!uid && allowlist.includes(uid);
}
