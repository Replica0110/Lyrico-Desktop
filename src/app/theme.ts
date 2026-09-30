import type { ThemeMode } from "../backend/audioApi";

let current: ThemeMode = "system";
const listeners = new Set<(mode: ThemeMode) => void>();

export function getThemeMode(): ThemeMode {
  return current;
}

export function setThemeMode(mode: ThemeMode): void {
  if (current === mode) return;
  current = mode;
  listeners.forEach((listener) => listener(mode));
}

export function subscribeTheme(listener: (mode: ThemeMode) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function prefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}
