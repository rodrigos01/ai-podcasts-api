import { auth } from "./firebase";

const BASE = "/admin/api/podcasts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the admin API with the signed-in user's ID token. */
export async function api<T = void>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = await auth.currentUser?.getIdToken();
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) {
    const detail = await res.json().then((b: { error?: string; message?: string }) => b.error ?? b.message, () => undefined);
    throw new ApiError(res.status, detail ?? `${res.status} ${res.statusText}`);
  }
  return res.status === 204 || res.headers.get("content-length") === "0" ? (undefined as T) : ((await res.json()) as T);
}
