import { diff3Merge } from 'node-diff3';

export type MergeOutcome = { clean: true; text: string } | { clean: false };

/** A trailing newline becomes a final '' element, so join('\n') round-trips exactly. */
function lines(text: string): string[] {
  return text.split('\n');
}

/** Line-based three-way merge. Returns `clean: false` when both sides changed the same region differently. */
export function merge3(base: string, ours: string, theirs: string): MergeOutcome {
  if (ours === theirs) return { clean: true, text: ours };
  if (ours === base) return { clean: true, text: theirs };
  if (theirs === base) return { clean: true, text: ours };
  const regions = diff3Merge<string>(lines(ours), lines(base), lines(theirs), { excludeFalseConflicts: true });
  if (regions.some((r) => r.conflict)) return { clean: false };
  return { clean: true, text: regions.flatMap((r) => r.ok ?? []).join('\n') };
}
