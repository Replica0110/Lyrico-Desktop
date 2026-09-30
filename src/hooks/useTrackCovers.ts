import { useEffect, useMemo, useState } from "react";
import { loadTrackCovers } from "../backend/audioApi";

const coverCache = new Map<string, string>();
const pendingRequests = new Map<string, { promise: Promise<void>; resolve: () => void }>();
const queuedPaths = new Set<string>();
const defaultRetryDelays = [0, 150, 500];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

export function useTrackCovers(paths: string[]) {
  const [version, setVersion] = useState(0);
  const pathKey = paths.join("\u0000");

  useEffect(() => {
    const requestedPaths = pathKey ? pathKey.split("\u0000") : [];
    if (requestedPaths.every((path) => coverCache.has(path))) return;

    let cancelled = false;
    void preloadTrackCovers(requestedPaths).finally(() => {
      if (!cancelled) setVersion((value) => value + 1);
    });

    return () => {
      cancelled = true;
    };
  }, [pathKey]);

  return useMemo(() => {
    const covers = new Map<string, string>();
    for (const path of paths) {
      const cover = coverCache.get(path);
      if (cover) covers.set(path, cover);
    }
    return covers;
  }, [pathKey, version]);
}

export function useTrackCover(path: string | undefined, enabled = true) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled || !path || coverCache.has(path)) return;
    let cancelled = false;
    void preloadTrackCovers([path]).finally(() => {
      if (!cancelled) setVersion((value) => value + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, path]);
  void version;
  return path ? coverCache.get(path) : undefined;
}

export function updateCachedCover(path: string, coverDataUrl?: string) {
  if (coverDataUrl) {
    coverCache.set(path, coverDataUrl);
  } else {
    coverCache.delete(path);
  }
}

export function invalidateCachedCovers(paths: string[]) {
  for (const path of paths) coverCache.delete(path);
}

export async function preloadTrackCovers(paths: string[], retryDelays = defaultRetryDelays) {
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  for (const delay of retryDelays) {
    const missingPaths = uniquePaths.filter((path) => !coverCache.has(path));
    if (missingPaths.length === 0) return;
    if (delay > 0) await wait(delay);

    const pending = requestCoverBatch(missingPaths);
    await Promise.allSettled(pending);
  }
}

export function readCachedTrackCover(path: string) {
  return coverCache.get(path);
}

export function resetTrackCoverCache() {
  coverCache.clear();
  pendingRequests.clear();
  queuedPaths.clear();
  if (flushTimer !== undefined) globalThis.clearTimeout(flushTimer);
  flushTimer = undefined;
}

function requestCoverBatch(paths: string[]) {
  const requests: Promise<void>[] = [];
  for (const path of paths) {
    if (coverCache.has(path)) continue;
    let pending = pendingRequests.get(path);
    if (!pending) {
      let resolve: () => void = () => {};
      const promise = new Promise<void>((next) => {
        resolve = next;
      });
      pending = { promise, resolve };
      pendingRequests.set(path, pending);
      queuedPaths.add(path);
    }
    requests.push(pending.promise);
  }
  scheduleFlush();
  return [...new Set(requests)];
}

function scheduleFlush() {
  if (flushTimer !== undefined || queuedPaths.size === 0) return;
  flushTimer = globalThis.setTimeout(() => {
    flushTimer = undefined;
    void flushCoverQueue();
  }, 16);
}

async function flushCoverQueue() {
  const paths = [...queuedPaths].slice(0, 8);
  for (const path of paths) queuedPaths.delete(path);
  try {
    const covers = await loadTrackCovers(paths);
    for (const cover of covers) {
      if (cover.coverDataUrl) coverCache.set(cover.path, cover.coverDataUrl);
    }
  } catch {
    // A failed load remains a cache miss so preloadTrackCovers can retry it.
  } finally {
    for (const path of paths) {
      pendingRequests.get(path)?.resolve();
      pendingRequests.delete(path);
    }
    scheduleFlush();
  }
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
