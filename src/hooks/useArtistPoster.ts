import { useEffect, useState, useSyncExternalStore } from "react";
import { readImageFile } from "../backend/audioApi";
import { artistPosterBaseNames } from "../domain/artistPoster";
import { ImageCache } from "../domain/imageCache";

const cache = new ImageCache(8 * 1024 * 1024);
const pending = new Map<string, { promise: Promise<string | undefined>; consumers: Set<AbortSignal> }>();
const listeners = new Set<() => void>();
let revision = 0;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getRevision = () => revision;
export function invalidateArtistPosters() {
  revision++;
  cache.clear();
  for (const listener of listeners) listener();
}
let running = 0;
const waiting: (() => void)[] = [];

async function load(folder: string, artist: string, signal: AbortSignal, requestRevision: number) {
  const key = JSON.stringify([folder, artist]);
  if (cache.has(key)) return cache.get(key);
  const requestKey = `${requestRevision}:${key}`;
  let request = pending.get(requestKey);
  if (!request) {
    const consumers = new Set([signal]);
    const active = () => revision === requestRevision && [...consumers].some(consumer => !consumer.aborted);
    request = { consumers, promise: (async () => {
      if (running >= 3) await new Promise<void>(resolve => waiting.push(resolve));
      else running++;
      try {
        if (!active()) return;
        for (const base of artistPosterBaseNames(artist)) {
          for (const extension of ["jpg", "jpeg", "png", "webp"]) {
            if (!active()) return;
            try {
              const value = await readImageFile(`${folder}\\${base}.${extension}`, 384);
              if (active()) cache.set(key, value);
              return value;
            } catch { /* Try the next supported filename. */ }
          }
        }
        // Bound missing-poster entries so scrolling does not repeat every candidate.
        if (active()) cache.set(key, undefined);
      } finally {
        const next = waiting.shift();
        if (next) next();
        else running--;
      }
    })().finally(() => pending.delete(requestKey)) };
    pending.set(requestKey, request);
  }
  request.consumers.add(signal);
  return request.promise;
}

export function useArtistPoster(folder: string, artist: string, enabled: boolean) {
  const key = JSON.stringify([folder, artist]);
  const currentRevision = useSyncExternalStore(subscribe, getRevision);
  const [result, setResult] = useState<{ key: string; revision: number; value?: string }>();
  useEffect(() => {
    setResult(undefined);
    if (!folder || !enabled) return;
    const controller = new AbortController();
    void load(folder, artist, controller.signal, currentRevision).then(value => {
      if (!controller.signal.aborted) setResult({ key, revision: currentRevision, value });
    });
    return () => controller.abort();
  }, [folder, artist, key, enabled, currentRevision]);
  return enabled && result?.key === key && result.revision === currentRevision ? result.value : undefined;
}
