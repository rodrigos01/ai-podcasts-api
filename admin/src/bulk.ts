import { useEffect, useState } from "react";

export interface BulkOutcome {
  /** What was run, e.g. "Deleted". */
  label: string;
  done: number;
  failures: { id: string; message: string }[];
}

/** Runs `fn` for every id, a few at a time, collecting failures instead of stopping at the first. */
export async function runAll(
  label: string,
  ids: string[],
  fn: (id: string) => Promise<unknown>,
  concurrency = 4,
): Promise<BulkOutcome> {
  const failures: BulkOutcome["failures"] = [];
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++]!;
      try {
        await fn(id);
      } catch (err) {
        failures.push({ id, message: err instanceof Error ? err.message : String(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  return { label, done: ids.length - failures.length, failures };
}

/** A set of selected row ids that forgets ids no longer in `available` (deleted, filtered out). */
export function useSelection(available: string[] | undefined) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const key = available?.join("|");
  useEffect(() => {
    setSelected((prev) => {
      const present = new Set(available);
      const next = new Set([...prev].filter((id) => present.has(id)));
      return next.size === prev.size ? prev : next;
    });
    // `key` stands in for the list's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return {
    selected,
    ids: [...selected],
    toggle: (id: string) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    setAll: (all: boolean) => setSelected(all ? new Set(available) : new Set()),
    clear: () => setSelected(new Set()),
  };
}
