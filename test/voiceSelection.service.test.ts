import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/data/designedVoice.repository", () => ({
  listSessionVoices: vi.fn(),
  markVoicesLinked: vi.fn(),
  deleteDesignedVoiceRecords: vi.fn(),
}));
vi.mock("../src/llm/ttsClient", () => ({ deleteVoice: vi.fn() }));

import {
  deleteDesignedVoiceRecords,
  listSessionVoices,
  markVoicesLinked,
} from "../src/data/designedVoice.repository";
import { deleteVoice } from "../src/llm/ttsClient";
import { createVoicePicker } from "../src/services/voiceSelection.service";
import type { VoiceDecision } from "../src/utils/voiceDecision";

const voice = (voiceId: string, extra: object = {}) => ({
  voiceId,
  sessionId: "s1",
  ownerId: "u1",
  prompt: `prompt of ${voiceId}`,
  createdAt: 1,
  ...extra,
});

const applied = (voiceId: string): VoiceDecision => ({
  fields: {
    resolvedVoiceId: voiceId,
    resolvedVoiceOrigin: "design",
    resolvedVoiceHash: "h",
    resolvedVoicePinned: true,
  },
});

describe("createVoicePicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listSessionVoices).mockResolvedValue([
      voice("voice_a"),
      voice("voice_b"),
      voice("voice_c"),
      voice("voice_kept", { linked: true }),
    ]);
  });

  it("accepts only the caller's unlinked candidates in the session; anything else is no pick", async () => {
    const picker = await createVoicePicker("u1", "s1");
    expect(listSessionVoices).toHaveBeenCalledWith("s1", "u1");
    expect(picker.pick("voice_b")).toEqual({ voiceId: "voice_b", prompt: "prompt of voice_b" });
    expect(picker.pick("voice_kept")).toBeNull(); // already stored somewhere: an echo
    expect(picker.pick("voice_unknown")).toBeNull();
    expect(picker.pick(undefined)).toBeNull();
  });

  it("without a session there is nothing to pick and nothing to list", async () => {
    const picker = await createVoicePicker("u1", undefined);
    expect(listSessionVoices).not.toHaveBeenCalled();
    expect(picker.pick("voice_a")).toBeNull();
  });

  it("links the applied picks and deletes every other candidate, but never a linked voice", async () => {
    const picker = await createVoicePicker("u1", "s1");
    await picker.finish([applied("voice_b")]);

    expect(markVoicesLinked).toHaveBeenCalledWith(["voice_b"]);
    expect(vi.mocked(deleteVoice).mock.calls.map(([id]) => id).sort()).toEqual(["voice_a", "voice_c"]);
    expect(deleteDesignedVoiceRecords).toHaveBeenCalledWith(["voice_a", "voice_c"]);
  });

  it("also deletes the stored voices a save replaced", async () => {
    const picker = await createVoicePicker("u1", "s1");
    await picker.finish([{ ...applied("voice_a"), replacedVoiceId: "voice_old" }]);
    expect(vi.mocked(deleteVoice).mock.calls.map(([id]) => id)).toContain("voice_old");
  });

  it("deletes the whole session's candidates when nothing was picked", async () => {
    const picker = await createVoicePicker("u1", "s1");
    await picker.finish([{ fields: null }]);
    expect(markVoicesLinked).toHaveBeenCalledWith([]);
    expect(deleteVoice).toHaveBeenCalledTimes(3);
  });

  it("swallows cleanup failures", async () => {
    vi.mocked(markVoicesLinked).mockRejectedValueOnce(new Error("firestore down"));
    const picker = await createVoicePicker("u1", "s1");
    await expect(picker.finish([applied("voice_a")])).resolves.toBeUndefined();
  });
});
