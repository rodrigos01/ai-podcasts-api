import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/data/voiceUsage.repository", () => ({ findVoicesInUse: vi.fn() }));
vi.mock("../src/llm/ttsClient", () => ({ deleteVoice: vi.fn() }));

import { findVoicesInUse } from "../src/data/voiceUsage.repository";
import { deleteVoice } from "../src/llm/ttsClient";
import { deleteVoicesIfUnused } from "../src/services/voiceCleanup.service";

describe("deleteVoicesIfUnused", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes voices nothing references", async () => {
    vi.mocked(findVoicesInUse).mockResolvedValue(new Set());
    expect(await deleteVoicesIfUnused(["voice_a", "voice_b"])).toEqual(["voice_a", "voice_b"]);
    expect(deleteVoice).toHaveBeenCalledTimes(2);
  });

  it("keeps a voice another podcast or episode still uses", async () => {
    vi.mocked(findVoicesInUse).mockResolvedValue(new Set(["voice_shared"]));
    expect(await deleteVoicesIfUnused(["voice_shared", "voice_free"])).toEqual(["voice_free"]);
    expect(deleteVoice).toHaveBeenCalledTimes(1);
    expect(deleteVoice).toHaveBeenCalledWith("voice_free");
  });

  it("checks each distinct id once", async () => {
    vi.mocked(findVoicesInUse).mockResolvedValue(new Set());
    await deleteVoicesIfUnused(["voice_a", "voice_a"]);
    expect(findVoicesInUse).toHaveBeenCalledWith(["voice_a"]);
    expect(deleteVoice).toHaveBeenCalledTimes(1);
  });

  it("keeps everything when usage can't be checked", async () => {
    vi.mocked(findVoicesInUse).mockRejectedValue(new Error("firestore down"));
    expect(await deleteVoicesIfUnused(["voice_a"])).toEqual([]);
    expect(deleteVoice).not.toHaveBeenCalled();
  });

  it("does nothing for no ids", async () => {
    expect(await deleteVoicesIfUnused([])).toEqual([]);
    expect(findVoicesInUse).not.toHaveBeenCalled();
  });
});
