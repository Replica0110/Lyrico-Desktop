import { builtinArtistSeparators } from "./library";
import { normalizedArtistKey } from "./artistKey";
import type { ArtistSplitConfig } from "../app/types";

/**
 * Artist-splitting rules, ported from the mobile app (`ArtistSplitSettingsViewModel` +
 * `ArtistSplitDefaults`). Keep the two platforms identical: the comparison keys, the
 * whitespace policy and the "visible built-in" condition are all observable behaviour.
 */

export { normalizedArtistKey };

/**
 * Comparison key for custom separators.
 * Mobile parity: separators compare exactly after trimming — case and inner whitespace matter,
 * because a separator such as " feat. " deliberately carries spaces.
 */
export function separatorKey(value: string): string {
  return value.trim();
}

export type RuleRejection = "empty" | "duplicate" | "duplicateBuiltin";

/** Built-in separators that are currently part of the effective set (mirrors the config's visibility). */
export function visibleBuiltinSeparatorIds(config: ArtistSplitConfig): Set<string> {
  return new Set(
    builtinArtistSeparators
      .filter((item) => !config.hiddenBuiltinSeparatorIds.includes(item.id))
      .filter((item) => config.builtinSeparatorOverrides[item.id] ?? item.defaultEnabled)
      .map((item) => item.id),
  );
}

/**
 * Validate a custom separator before it is stored. The stored value keeps its raw whitespace,
 * so validation only decides whether the value is allowed at all.
 */
export function validateSeparatorRule(
  input: string,
  existing: ReadonlyArray<{ id: string; value: string }>,
  options: { visibleBuiltinIds: ReadonlySet<string>; editingId?: string },
): RuleRejection | undefined {
  if (!input.trim()) return "empty";
  const key = separatorKey(input);
  if (existing.some((item) => item.id !== options.editingId && separatorKey(item.value) === key)) return "duplicate";
  const clashesWithBuiltin = builtinArtistSeparators.some(
    (item) => options.visibleBuiltinIds.has(item.id) && separatorKey(item.value) === key,
  );
  return clashesWithBuiltin ? "duplicateBuiltin" : undefined;
}

/** Validate a "keep intact" artist before it is stored; the stored value keeps its raw text. */
export function validateNoSplitRule(
  input: string,
  existing: ReadonlyArray<{ id: string; name: string }>,
  editingId?: string,
): RuleRejection | undefined {
  if (!input.trim()) return "empty";
  const key = normalizedArtistKey(input);
  if (existing.some((item) => item.id !== editingId && normalizedArtistKey(item.name) === key)) return "duplicate";
  return undefined;
}
