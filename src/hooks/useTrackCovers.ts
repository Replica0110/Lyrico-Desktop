import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { loadTrackCovers } from "../backend/audioApi";

function createCoverQueue(artwork: boolean) {
  return {
    artwork,
    coverCache: new Map<string, string>(),
    pendingRequests: new Map<string, { promise: Promise<void>; resolve: () => void }>(),
    queuedPaths: new Set<string>(),
    generations: new Map<string, number>(),
    flushTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  };
}

// Keep both request deduplication and cached previews separate by resolution.
const thumbnailQueue = createCoverQueue(false);
const artworkQueue = createCoverQueue(true);
type CoverQueue = ReturnType<typeof createCoverQueue>;
const { coverCache } = thumbnailQueue;
const defaultRetryDelays = [0, 150, 500];
const listeners = new Set<() => void>();
let cacheVersion = 0;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getCacheVersion = () => cacheVersion;
function notifyCacheChanged() {
  cacheVersion += 1;
  for (const listener of listeners) listener();
}

function invalidatePath(queue: CoverQueue, path: string) {
  queue.coverCache.delete(path);
  queue.generations.set(path, (queue.generations.get(path) ?? 0) + 1);
}

export function useTrackCovers(paths: string[]) {
  const cacheRevision = useSyncExternalStore(subscribe, getCacheVersion);
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
  }, [pathKey, cacheRevision]);

  return useMemo(() => {
    const covers = new Map<string, string>();
    for (const path of paths) {
      const cover = coverCache.get(path);
      if (cover) covers.set(path, cover);
    }
    return covers;
  }, [pathKey, version, cacheRevision]);
}

export function useTrackCover(path: string | undefined, enabled = true, artwork = false) {
  const cacheRevision = useSyncExternalStore(subscribe, getCacheVersion);
  const queue = artwork ? artworkQueue : thumbnailQueue;
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled || !path || queue.coverCache.has(path)) return;
    let cancelled = false;
    void preloadTrackCovers([path], defaultRetryDelays, artwork).finally(() => {
      if (!cancelled) setVersion((value) => value + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, path, artwork, queue, cacheRevision]);
  void version;
  return path ? queue.coverCache.get(path) : undefined;
}

export function updateCachedCover(path: string, coverDataUrl?: string) {
  invalidatePath(thumbnailQueue, path);
  invalidatePath(artworkQueue, path);
  if (coverDataUrl) {
    coverCache.set(path, coverDataUrl);
    artworkQueue.coverCache.set(path, coverDataUrl);
  } else {
    coverCache.delete(path);
    artworkQueue.coverCache.delete(path);
  }
  notifyCacheChanged();
}

export function invalidateCachedCovers(paths: string[]) {
  for (const path of paths) {
    invalidatePath(thumbnailQueue, path);
    invalidatePath(artworkQueue, path);
  }
  if (paths.length) notifyCacheChanged();
}

export async function preloadTrackCovers(paths: string[], retryDelays = defaultRetryDelays, artwork = false) {
  const queue = artwork ? artworkQueue : thumbnailQueue;
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  for (const delay of retryDelays) {
    const missingPaths = uniquePaths.filter((path) => !queue.coverCache.has(path));
    if (missingPaths.length === 0) return;
    if (delay > 0) await wait(delay);

    const pending = requestCoverBatch(missingPaths, queue);
    await Promise.allSettled(pending);
  }
}

export function readCachedTrackCover(path: string) {
  return coverCache.get(path);
}

export function resetTrackCoverCache() {
  for (const queue of [thumbnailQueue, artworkQueue]) {
    for (const path of new Set([...queue.coverCache.keys(), ...queue.pendingRequests.keys()])) invalidatePath(queue, path);
    queue.coverCache.clear();
    for (const pending of queue.pendingRequests.values()) pending.resolve();
    queue.pendingRequests.clear();
    queue.queuedPaths.clear();
    if (queue.flushTimer !== undefined) globalThis.clearTimeout(queue.flushTimer);
    queue.flushTimer = undefined;
  }
  notifyCacheChanged();
}

function requestCoverBatch(paths: string[], queue: CoverQueue) {
  const { coverCache, pendingRequests, queuedPaths } = queue;
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
  scheduleFlush(queue);
  return [...new Set(requests)];
}

function scheduleFlush(queue: CoverQueue) {
  if (queue.flushTimer !== undefined || queue.queuedPaths.size === 0) return;
  queue.flushTimer = globalThis.setTimeout(() => {
    queue.flushTimer = undefined;
    void flushCoverQueue(queue);
  }, 16);
}

async function flushCoverQueue(queue: CoverQueue) {
  const { coverCache, pendingRequests, queuedPaths } = queue;
  const paths = [...queuedPaths].slice(0, 8);
  const generations = new Map(paths.map((path) => [path, queue.generations.get(path) ?? 0]));
  for (const path of paths) queuedPaths.delete(path);
  try {
    const covers = await loadTrackCovers(paths, queue.artwork);
    for (const cover of covers) {
      // Ignore a preview read before a scan or tag write invalidated this path.
      if (cover.coverDataUrl && generations.get(cover.path) === (queue.generations.get(cover.path) ?? 0)) {
        coverCache.set(cover.path, cover.coverDataUrl);
      }
    }
    if (covers.length) notifyCacheChanged();
  } catch {
    // A failed load remains a cache miss so preloadTrackCovers can retry it.
  } finally {
    for (const path of paths) {
      pendingRequests.get(path)?.resolve();
      pendingRequests.delete(path);
    }
    scheduleFlush(queue);
  }
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
