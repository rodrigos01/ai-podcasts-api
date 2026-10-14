import { collection, doc, onSnapshot, orderBy, query, where, type Query, type QueryConstraint } from "firebase/firestore";
import { useEffect, useState } from "react";
import { db } from "./firebase";
import type { Episode, Podcast, Source } from "./types";

interface Live<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | null;
}

/** Subscribes to a query for as long as the component is mounted. */
function useLiveQuery<T>(key: string, build: (() => Query) | null): Live<T[]> {
  const [state, setState] = useState<Live<T[]>>({ data: undefined, loading: true, error: null });
  useEffect(() => {
    if (!build) return;
    setState({ data: undefined, loading: true, error: null });
    return onSnapshot(
      build(),
      (snap) => setState({ data: snap.docs.map((d) => ({ ...d.data(), id: d.id }) as T), loading: false, error: null }),
      (error) => setState({ data: undefined, loading: false, error }),
    );
    // `key` stands in for the query's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

function useLiveDoc<T>(path: string[]): Live<T | null> {
  const [state, setState] = useState<Live<T | null>>({ data: undefined, loading: true, error: null });
  const key = path.join("/");
  useEffect(() => {
    setState({ data: undefined, loading: true, error: null });
    return onSnapshot(
      doc(db, key),
      (snap) => setState({ data: snap.exists() ? ({ ...snap.data(), id: snap.id } as T) : null, loading: false, error: null }),
      (error) => setState({ data: undefined, loading: false, error }),
    );
  }, [key]);
  return state;
}

export function usePodcasts(ownerId: string) {
  const constraints: QueryConstraint[] = ownerId ? [where("ownerId", "==", ownerId)] : [];
  // Newest first, sorted client-side: with an owner filter, Firestore would need a composite index for orderBy.
  const result = useLiveQuery<Podcast>(`podcasts|${ownerId}`, () => query(collection(db, "podcasts"), ...constraints));
  return { ...result, data: result.data?.slice().sort((a, b) => b.createdAt - a.createdAt) };
}

export const usePodcast = (podcastId: string) => useLiveDoc<Podcast>(["podcasts", podcastId]);
export const useEpisode = (podcastId: string, episodeId: string) => useLiveDoc<Episode>(["podcasts", podcastId, "episodes", episodeId]);

export function useEpisodes(podcastId: string) {
  const result = useLiveQuery<Episode>(`episodes|${podcastId}`, () => query(collection(db, "podcasts", podcastId, "episodes"), orderBy("createdAt")));
  return result;
}

export function useSources(podcastId: string) {
  return useLiveQuery<Source>(`sources|${podcastId}`, () => query(collection(db, "podcasts", podcastId, "sources"), orderBy("createdAt")));
}
