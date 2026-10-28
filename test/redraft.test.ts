import { describe, expect, it } from "vitest";
import type { Person } from "../src/schemas/person.schema";
import { redraftToUpdate } from "../src/utils/redraft";

const guest = (name: string): Person =>
  ({ id: `id-${name}`, name, persona: "p", voice: "v", voicePrompt: "x", resolvedVoiceId: "voice_1" }) as Person;

const draftGuest = { name: "New", persona: "new persona", voice: "calm" };
const base = { title: "T", topics: "Topics" };

describe("redraftToUpdate", () => {
  it("replaces the guest with a new one (no id, so it is stored as a new person) and reports the old one", () => {
    const old = guest("Old");
    const { update, replacedGuests } = redraftToUpdate({ guests: [old] }, { ...base, guests: [draftGuest] });
    expect(update.guests).toHaveLength(1);
    expect(update.guests?.[0]).toMatchObject({ name: "New", voicePrompt: expect.stringContaining("New") });
    expect(update.guests?.[0]?.id).toBeUndefined();
    expect(replacedGuests).toEqual([old]);
  });

  it("keeps the cast when the guest count would change", () => {
    const old = guest("Old");
    expect(redraftToUpdate({ guests: [old] }, { ...base, guests: [] })).toEqual({
      update: { title: "T", topics: "Topics", productionNotes: null },
      replacedGuests: [],
    });
    const noGuest = redraftToUpdate({ guests: [] }, { ...base, guests: [draftGuest] });
    expect(noGuest.update.guests).toBeUndefined();
    expect(noGuest.replacedGuests).toEqual([]);
  });

  it("clears production notes the redraft doesn't set, and keeps ones it does", () => {
    expect(redraftToUpdate({ guests: [] }, { ...base, guests: [] }).update.productionNotes).toBeNull();
    expect(redraftToUpdate({ guests: [] }, { ...base, productionNotes: "n", guests: [] }).update.productionNotes).toBe("n");
  });
});
