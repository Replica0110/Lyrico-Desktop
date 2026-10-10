import { invoke, isTauri } from "@tauri-apps/api/core";

let windowHandlersInstalled = false;
const recent = new Map<string, number>();

// Arbitrary rejection values and Error messages can contain plugin credentials.
// Persist the error type and stack frames, never user or network payloads.
function stackFrames(error: unknown): string {
  if (!(error instanceof Error)) return "Non-Error rejection";
  const name = ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError"].includes(error.name) ? error.name : "Error";
  const header = `${error.name}: ${error.message}`;
  const stack = error.stack?.startsWith(header) ? error.stack.slice(header.length) : "";
  return [name, ...stack.split("\n").filter(line => /^\s+at\s/.test(line)).slice(0, 15)].join("\n");
}

export function reportFrontendError(kind: "render" | "error" | "unhandledrejection", error: unknown, location = "") {
  if (!isTauri()) return;
  const detail = `${stackFrames(error)}\n${location}`.slice(0, 4096);
  const key = `${kind}:${detail}`;
  const now = Date.now();
  for (const [entry, timestamp] of recent) if (now - timestamp > 60_000) recent.delete(entry);
  if (recent.has(key) || recent.size >= 20) return;
  recent.set(key, now);
  void invoke("report_frontend_error", { kind, detail }).catch(() => { /* Logging must not cause another unhandled rejection. */ });
}

export function installFrontendDiagnostics() {
  if (windowHandlersInstalled) return;
  windowHandlersInstalled = true;
  window.addEventListener("error", event => reportFrontendError("error", event.error, `${event.filename}:${event.lineno}:${event.colno}`));
  window.addEventListener("unhandledrejection", event => reportFrontendError("unhandledrejection", event.reason));
}
