import { findVoicesInUse } from "../data/voiceUsage.repository";
import { deleteVoice } from "../llm/ttsClient";

/**
 * The one way the server deletes a stored voice. Hosts are often shared by several podcasts (and
 * a picked voice by several episodes) as copies of the same `resolvedVoiceId`, so a voice is only
 * deleted when no stored host or guest still references it. Callers must have already removed
 * the reference they are cleaning up (the person's doc is saved or deleted first).
 *
 * If usage can't be checked the voices are kept: a leaked voice expires on its own, a deleted
 * one that's still referenced breaks synthesis with a 404.
 *
 * Returns the ids actually deleted.
 */
export async function deleteVoicesIfUnused(voiceIds: string[]): Promise<string[]> {
  const ids = [...new Set(voiceIds)];
  if (ids.length === 0) return [];

  let inUse: Set<string>;
  try {
    inUse = await findVoicesInUse(ids);
  } catch (err) {
    console.error("Could not check whether voices are still in use; keeping them:", err);
    return [];
  }
  const unused = ids.filter((id) => !inUse.has(id));
  for (const id of ids) {
    if (inUse.has(id)) console.log(`Keeping voice ${id}: another podcast or episode still uses it.`);
  }
  await Promise.all(unused.map((id) => deleteVoice(id)));
  return unused;
}
