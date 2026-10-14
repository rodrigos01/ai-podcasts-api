/**
 * Grants (or revokes) admin access to the /admin API by setting the `admin`
 * custom claim on Firebase Auth users — NOT run automatically by anything.
 *
 * Usage:
 *   npx tsx scripts/grant-admin.ts <uid> [<uid>...]
 *   npx tsx scripts/grant-admin.ts --revoke <uid> [<uid>...]
 *
 * Reads the same .env / credentials as the app itself (config/firebase.ts),
 * so it acts on whichever project they point at. Other custom claims on the
 * user are kept. The claim reaches the user's ID token the next time it
 * refreshes (up to an hour); signing out and in again picks it up at once.
 */
import { getAuth } from "firebase-admin/auth";
import { firebaseApp } from "../src/config/firebase";
import { withAdminClaim } from "../src/utils/admin";

async function main() {
  const args = process.argv.slice(2);
  const revoke = args.includes("--revoke");
  const uids = args.filter((arg) => arg !== "--revoke");
  if (uids.length === 0) {
    console.error("Usage: grant-admin.ts [--revoke] <uid> [<uid>...]");
    process.exit(1);
  }

  const auth = getAuth(firebaseApp);
  let failed = false;
  for (const uid of uids) {
    try {
      const user = await auth.getUser(uid);
      await auth.setCustomUserClaims(uid, withAdminClaim(user.customClaims, !revoke));
      console.log(`${revoke ? "Revoked admin from" : "Granted admin to"} ${uid}${user.email ? ` (${user.email})` : ""}`);
    } catch (err) {
      failed = true;
      console.error(`${uid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
