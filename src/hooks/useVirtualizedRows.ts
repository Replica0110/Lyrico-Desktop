import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { getLibraryWindow } from "../domain/libraryWindow";

const DEFAULT_VIEWPORT_HEIGHT = 640;

export function useVirtualizedRows(itemCount: number, rowHeight = 60, overscan = 8) {
  const rowsRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({
    scrollTop: 0,
    height: DEFAULT_VIEWPORT_HEIGHT,
  });

  const updateViewport = useCallback(() => {
    const rows = rowsRef.current;
    if (!rows) return;

    const scrollParent = findScrollParent(rows);
    const rowsRect = rows.getBoundingClientRect();
    const parentRect = scrollParent instanceof HTMLElement
      ? scrollParent.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight };
    const totalHeight = itemCount * rowHeight;
    const scrollTop = Math.max(0, parentRect.top - rowsRect.top);
    const visibleBottom = Math.min(totalHeight, parentRect.bottom - rowsRect.top);
    const height = Math.max(rowHeight, visibleBottom - scrollTop);

    setViewport((current) => {
      if (Math.abs(current.scrollTop - scrollTop) < 1 && Math.abs(current.height - height) < 1) {
        return current;
      }
      return { scrollTop, height };
    });
  }, [itemCount, rowHeight]);

  useLayoutEffect(() => {
    const rows = rowsRef.current;
    if (!rows) return;

    const scrollParent = findScrollParent(rows);
    let frame: number | undefined;
    const scheduleUpdate = () => {
      if (frame !== undefined) return;
      if (typeof window.requestAnimationFrame !== "function") {
        updateViewport();
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        updateViewport();
      });
    };

    scrollParent.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(rows);
    if (scrollParent instanceof HTMLElement) resizeObserver?.observe(scrollParent);
    updateViewport();

    return () => {
      scrollParent.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      resizeObserver?.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [updateViewport]);

  const { startIndex, endIndex } = getLibraryWindow(
    itemCount,
    viewport.scrollTop,
    viewport.height,
    rowHeight,
    overscan,
  );

  return {
    rowsRef,
    startIndex,
    endIndex,
    topSpacerHeight: startIndex * rowHeight,
    bottomSpacerHeight: Math.max(0, (itemCount - endIndex) * rowHeight),
  };
}

function findScrollParent(element: HTMLElement): HTMLElement | Window {
  let parent = element.parentElement;
  while (parent) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
      return parent;
    }
    parent = parent.parentElement;
  }
  return window;
}
