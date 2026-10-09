// Episode generation runs in-process and detached from any request, so the
// instance running it can be recycled (or its CPU throttled) at any moment.
// A run therefore holds a short lease on its episode, refreshed while it's
// alive; once the lease goes stale, whoever next notices (a status poll, a
// /stream request) takes the episode over and resumes it — see
// utils/generationLease.ts and orchestrator.ts's ensureGenerationRunning.

// How often a running generation refreshes its lease on top of the refresh
// every progress write already does (the model can go a minute or more
// "thinking" before the first turn comes back, with nothing else to write).
export const GENERATION_HEARTBEAT_INTERVAL_MS = 15_000;

// How long a lease counts as live without a refresh. Several heartbeats'
// worth, so one slow Firestore write doesn't get a healthy run taken over;
// short enough that a dead run is picked up within about a minute.
export const GENERATION_LEASE_TTL_MS = 60_000;
