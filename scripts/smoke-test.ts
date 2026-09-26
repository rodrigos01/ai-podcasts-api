/**
 * End-to-end smoke test against a running instance of this API
 * (`npm run dev` in another terminal first). Exercises the full flow:
 * podcast wizard -> confirm -> source upload -> episode wizard -> confirm
 * -> poll status until ready -> fetch transcript -> stream audio (first
 * request generates it live; a second request serves the cached/finished
 * result).
 *
 * Uses real Gemini API calls, including real TTS synthesis — costs quota
 * and billed usage, and takes several minutes (audio generation is no
 * longer chunked; a whole episode synthesizes as one streaming call — see
 * AGENTS.md).
 */
const BASE_URL = process.env.SMOKE_TEST_BASE_URL ?? "http://localhost:3000";

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

function log(step: string, detail?: unknown) {
  console.log(`\n=== ${step} ===`);
  if (detail !== undefined) console.log(detail);
}

async function main() {
  log("1. Podcast wizard: generate options");
  const { options } = await api<{ options: any[] }>("POST", "/podcasts/wizard/options", {
    prompt: "A podcast where two friends review obscure kitchen gadgets.",
  });
  log("got options", options.map((o: any) => o.title));

  log("2. Confirm podcast (option 0)");
  const chosen = options[0];
  const podcast = await api<any>("POST", "/podcasts", {
    title: chosen.title,
    description: chosen.description,
    structure: chosen.structure,
    hosts: chosen.hosts,
  });
  log("created podcast", podcast.id);

  log("3. Upload a text source");
  const source = await api<any>("POST", `/podcasts/${podcast.id}/sources`, {
    title: "Gadget notes",
    contents: "This week's gadget is an avocado slicer shaped like a tiny guillotine.",
  });
  log("created source", source.id);

  log("4. Episode wizard: generate draft");
  const { draft } = await api<any>("POST", `/podcasts/${podcast.id}/episodes/wizard/options`, {
    sourceIds: [source.id],
  });
  log("got draft", draft.title);

  const hostIds = podcast.hosts.slice(0, 2).map((h: any) => h.id);
  const guests = hostIds.length === 2 ? [] : draft.guests;
  const participantHostIds = hostIds.length === 2 ? hostIds : [hostIds[0]];

  log("5. Confirm episode");
  const episode = await api<any>("POST", `/podcasts/${podcast.id}/episodes`, {
    title: draft.title,
    topics: draft.topics,
    length: "short",
    sourceIds: [source.id],
    participantHostIds,
    guests,
    productionNotes: draft.productionNotes,
  });
  log("episode created, status:", episode.status);

  log("6. Poll status until ready");
  let status = episode.status;
  while (status === "generating") {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await api<any>("GET", `/podcasts/${podcast.id}/episodes/${episode.id}/status`);
    status = s.status;
    console.log("  status:", s.status, s.progress);
  }
  if (status !== "ready") throw new Error(`Episode ended in status: ${status}`);

  log("7. Fetch full episode (transcript)");
  const final = await api<any>("GET", `/podcasts/${podcast.id}/episodes/${episode.id}`);
  console.log("transcript chars:", final.transcript.length);

  log("8. Stream audio (first request: generates it live)");
  const res1 = await fetch(`${BASE_URL}/podcasts/${podcast.id}/episodes/${episode.id}/audio/stream`);
  console.log("content-type:", res1.headers.get("content-type"), "status:", res1.status);
  await res1.arrayBuffer(); // drain the whole response so generation actually completes

  log("9. Stream audio again (expect the finished, cached Ogg)");
  const res2 = await fetch(`${BASE_URL}/podcasts/${podcast.id}/episodes/${episode.id}/audio/stream`);
  console.log("content-type:", res2.headers.get("content-type"), "content-length:", res2.headers.get("content-length"));

  log("Smoke test passed", { podcastId: podcast.id, episodeId: episode.id });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
