import { describe, expect, it } from "vitest";
import { artistPosterBaseNames } from "./artistPoster";

describe("artist poster names", () => {
  it("generates exact and Windows-safe variants", () => {
    expect(artistPosterBaseNames("AC/DC")).toEqual([
      "AC/DC",
      "AC／DC",
      "AC-DC",
      "AC_DC",
      "ACDC",
    ]);
  });
});
