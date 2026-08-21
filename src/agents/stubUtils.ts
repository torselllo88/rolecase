/**
 * Small deterministic helpers shared by stub agents so mock output is stable
 * per input (same vacancy -> same analysis) without needing any real model call.
 */

export function stableHash(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function pick<T>(items: readonly T[], seed: number): T {
  return items[seed % items.length] as T;
}

/** Deterministically picks two distinct entries from a bank of 2+ items — used where a stub needs variety without repeating the same line twice in one response. */
export function pickPair<T>(items: readonly T[], seed: number): [T, T] {
  const i = seed % items.length;
  const j = (i + 1) % items.length;
  return [items[i] as T, items[j] as T];
}

export function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function lowerFirst(s: string): string {
  return s.length > 0 ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/** Joins a list of short phrases into a natural "A, B, and C" clause — used to weave multiple candidate strengths into one sentence instead of dumping them as a bare, period-joined list. */
export function joinNaturally(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
