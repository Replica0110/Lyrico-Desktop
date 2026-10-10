import { afterEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri: () => true }));
afterEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("frontend diagnostic boundary", () => {
  it("omits exception messages and arbitrary rejection payloads and deduplicates", async () => {
    const { reportFrontendError } = await import("./diagnostics");
    const error = new Error("private-token-and-payload");
    error.stack = "Error: private-token-and-payload\n    at save (app.js:12:3)";
    reportFrontendError("render", error, "in SongDetails");
    reportFrontendError("render", error, "in SongDetails");
    reportFrontendError("unhandledrejection", { token: "private-token-and-payload" });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("private-token-and-payload");
    expect(invoke.mock.calls[0][1].detail).toContain("app.js:12:3");
  });
  it("omits multiline messages even when they resemble stack frames", async () => {
    const { reportFrontendError } = await import("./diagnostics");
    const error = new Error("safe\n    at raw-private-token");
    error.name = "private-error-name";
    error.stack = `${error.name}: ${error.message}\n    at save (app.js:12:3)`;
    reportFrontendError("error", error);
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("private");
    expect(invoke.mock.calls[0][1].detail).toContain("app.js:12:3");
  });
  it("installs window listeners once and swallows logger failures", async () => {
    const addEventListener = vi.fn();
    vi.stubGlobal("window", { addEventListener });
    const { installFrontendDiagnostics, reportFrontendError } = await import("./diagnostics");
    installFrontendDiagnostics(); installFrontendDiagnostics();
    expect(addEventListener).toHaveBeenCalledTimes(2);
    invoke.mockRejectedValueOnce(new Error("Logger unavailable"));
    reportFrontendError("error", new Error("test"));
    await Promise.resolve();
  });
});
