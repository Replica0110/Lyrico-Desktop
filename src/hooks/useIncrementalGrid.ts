import { useEffect, useState, useTransition } from "react";

export function useIncrementalGrid(itemCount: number, pageSize = 40) {
  const [visibleCount, setVisibleCount] = useState(() => Math.min(itemCount, pageSize));
  const [sentinel, sentinelRef] = useState<HTMLDivElement | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [, startTransition] = useTransition();

  useEffect(() => {
    setVisibleCount(Math.min(itemCount, pageSize));
    setLoadingMore(false);
  }, [itemCount, pageSize]);

  useEffect(() => {
    if (!sentinel || visibleCount >= itemCount) { setLoadingMore(false); return; }
    if (typeof IntersectionObserver === "undefined") {
      setVisibleCount((current) => Math.min(itemCount, current + pageSize));
      return;
    }
    let frame: number | undefined;
    let scheduled = false;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || scheduled) return;
      scheduled = true;
      setLoadingMore(true);
      // Paint the footer before committing the next batch, without an artificial wait.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => startTransition(() => {
          setVisibleCount((current) => Math.min(itemCount, current + pageSize));
          setLoadingMore(false);
        }));
      });
    });
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [itemCount, pageSize, visibleCount, sentinel]);

  return { visibleCount, sentinelRef, hasMore: visibleCount < itemCount, loadingMore };
}
