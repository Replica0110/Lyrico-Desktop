import { useEffect, useState } from "react";
import { loadTrackCovers } from "../backend/audioApi";
import { ImageCache } from "../domain/imageCache";

function createQueue(artwork: boolean, budget: number) {
  return {
    artwork,
    cache: new ImageCache(budget),
    pending: new Map<string, { promise: Promise<string | undefined>; resolve: (value?: string) => void }>(),
    queued: new Set<string>(),
    running: false,
  };
}
const thumbnailQueue = createQueue(false, 8 * 1024 * 1024);
const artworkQueue = createQueue(true, 24 * 1024 * 1024);
type CoverQueue = ReturnType<typeof createQueue>;
const listeners = new Set<(paths: string[]) => void>();

function load(path: string, queue: CoverQueue) {
  if (queue.cache.has(path)) return Promise.resolve(queue.cache.get(path));
  let pending = queue.pending.get(path);
  if (!pending) {
    let resolve: (value?: string) => void = () => {};
    const promise = new Promise<string | undefined>(next => { resolve = next; });
    pending = { promise, resolve };
    queue.pending.set(path, pending);
    queue.queued.add(path);
    if (!queue.running) {
      queue.running = true;
      globalThis.setTimeout(() => void flush(queue), 16);
    }
  }
  return pending.promise;
}

async function flush(queue: CoverQueue) {
  while (queue.queued.size) {
    const paths = [...queue.queued].slice(0, 8);
    const requests = paths.map(path => queue.pending.get(path));
    for (const path of paths) queue.queued.delete(path);
    let covers: Awaited<ReturnType<typeof loadTrackCovers>> = [];
    try { covers = await loadTrackCovers(paths, queue.artwork); } catch { /* Keep failed reads retryable. */ }
    for (let index = 0; index < paths.length; index++) {
      const path = paths[index];
      const request = requests[index];
      // An old completion must not replace a request created after invalidation.
      if (request && queue.pending.get(path) === request) {
        const value = covers.find(cover => cover.path === path)?.coverDataUrl;
        if (value) queue.cache.set(path, value);
        queue.pending.delete(path);
        request.resolve(value);
      }
    }
  }
  queue.running = false;
}

export function useTrackCover(path: string | undefined, enabled = true, artwork = false) {
  const queue = artwork ? artworkQueue : thumbnailQueue;
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ path: string; artwork: boolean; revision: number; value?: string }>();
  useEffect(() => {
    const listener = (paths: string[]) => { if (path && paths.includes(path)) setRevision(value => value + 1); };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, [path]);
  useEffect(() => {
    setResult(undefined);
    if (!enabled || !path) return;
    let disposed = false;
    void (async () => {
      for (const delay of [0, 150, 500]) {
        if (delay) await new Promise(resolve => globalThis.setTimeout(resolve, delay));
        if (disposed) return;
        const value = await load(path, queue);
        if (disposed) return;
        if (value) { setResult({ path, artwork, revision, value }); return; }
      }
    })();
    return () => { disposed = true; };
  }, [enabled, path, artwork, queue, revision]);
  // Visible images retain a reference; LRU eviction must not create a reload loop.
  return enabled && result && result.path === path && result.artwork === artwork && result.revision === revision ? result.value : undefined;
}

export function invalidateCachedCovers(paths: string[]) {
  for (const queue of [thumbnailQueue, artworkQueue]) {
    for (const path of paths) {
      queue.cache.delete(path);
      queue.pending.get(path)?.resolve();
      queue.pending.delete(path);
      queue.queued.delete(path);
    }
  }
  if (paths.length) for (const listener of listeners) listener(paths);
}

export function updateCachedCover(path: string) {
  // Originals belong in the editor; reload sized previews after saving.
  invalidateCachedCovers([path]);
}
