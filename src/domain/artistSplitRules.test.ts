import { describe, expect, it } from "vitest";
import { builtinArtistSeparators } from "./library";
import { separatorKey, validateNoSplitRule, validateSeparatorRule, visibleBuiltinSeparatorIds } from "./artistSplitRules";
import type { ArtistSplitConfig } from "../app/types";

const config = (patch: Partial<ArtistSplitConfig> = {}): ArtistSplitConfig => ({
  enabled: true,
  artistSeparator: "/",
  builtinSeparatorOverrides: {},
  hiddenBuiltinSeparatorIds: [],
  customSeparators: [],
  builtinNoSplitArtistOverrides: {},
  customNoSplitArtists: [],
  ...patch,
});

const visible = config();

describe("artist split rules", () => {
  it("rejects blank values for both lists", () => {
    expect(validateSeparatorRule("   ", [], { visibleBuiltinIds: visibleBuiltinSeparatorIds(visible) })).toBe("empty");
    expect(validateNoSplitRule("", [])).toBe("empty");
  });

  it("compares separators exactly after trimming, so inner whitespace and case matter", () => {
    expect(separatorKey(" feat. ")).toBe("feat.");
    const existing = [{ id: "a", value: " feat. " }];
    const options = { visibleBuiltinIds: visibleBuiltinSeparatorIds(visible) };
    expect(validateSeparatorRule("feat.", existing, options)).toBe("duplicate");
    expect(validateSeparatorRule(" feat. ", existing, options)).toBe("duplicate");
    // Case is significant for separators, unlike artist names.
    expect(validateSeparatorRule("FEAT.", existing, options)).toBeUndefined();
    // A separator keeps its spaces; validation only decides whether it is allowed.
    expect(validateSeparatorRule(" with ", [], options)).toBeUndefined();
  });

  it("only blocks separators that collide with a currently visible built-in", () => {
    const slash = builtinArtistSeparators.find((item) => item.id === "slash")!;
    expect(validateSeparatorRule(slash.value, [], { visibleBuiltinIds: visibleBuiltinSeparatorIds(visible) })).toBe("duplicateBuiltin");

    const hidden = config({ hiddenBuiltinSeparatorIds: ["slash"] });
    expect(validateSeparatorRule(slash.value, [], { visibleBuiltinIds: visibleBuiltinSeparatorIds(hidden) })).toBeUndefined();

    const disabled = config({ builtinSeparatorOverrides: { slash: false } });
    expect(validateSeparatorRule(slash.value, [], { visibleBuiltinIds: visibleBuiltinSeparatorIds(disabled) })).toBeUndefined();

    // The whitespace-carrying built-ins are off by default, so they do not block either.
    expect(validateSeparatorRule(" feat. ", [], { visibleBuiltinIds: visibleBuiltinSeparatorIds(visible) })).toBeUndefined();
  });

  it("ignores the row being edited when checking for duplicates", () => {
    const existing = [{ id: "a", value: " with " }];
    expect(validateSeparatorRule(" with ", existing, { visibleBuiltinIds: visibleBuiltinSeparatorIds(visible), editingId: "a" })).toBeUndefined();
  });

  it("compares artist names by normalized key", () => {
    const existing = [{ id: "a", name: "Simon  &  Garfunkel" }];
    expect(validateNoSplitRule("simon & garfunkel", existing)).toBe("duplicate");
    expect(validateNoSplitRule(" Simon & Garfunkel ", existing)).toBe("duplicate");
    expect(validateNoSplitRule("Simon & Garfunkel", existing, "a")).toBeUndefined();
    expect(validateNoSplitRule("Earth, Wind & Fire", existing)).toBeUndefined();
    // The stored value keeps its original spacing; only the comparison is normalized.
    expect(validateNoSplitRule("BUMP  OF  CHICKEN", existing)).toBeUndefined();
  });
});
