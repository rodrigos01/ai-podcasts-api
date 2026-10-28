import { auth } from "./firebase";

const ADMIN_API = "/admin/api";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the podcast routes (`/admin/api/podcasts`) with the signed-in user's ID token. */
export const api = <T = void>(path: string, init: RequestInit0 = {}) => request<T>(`${ADMIN_API}/podcasts${path}`, init);

/** Calls the admin-only bulk operations (`/admin/api/bulk`). */
export const bulkApi = <T = void>(path: string, init: RequestInit0 = {}) => request<T>(`${ADMIN_API}/bulk${path}`, init);

type RequestInit0 = { method?: string; body?: unknown };

async function request<T>(url: string, init: RequestInit0): Promise<T> {
  const token = await auth.currentUser?.getIdToken();
  const res = await fetch(url, {
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
