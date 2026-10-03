import { basename, noteTitle } from './paths';

/** [[target#heading|alias]] — `target` may be a title or a path. */
export const WIKILINK_RE = /\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/g;

export interface WikiLink {
  target: string;
  heading?: string;
  alias?: string;
}

export function parseWikiLinks(text: string): WikiLink[] {
  return [...text.matchAll(WIKILINK_RE)].map((m) => ({
    target: m[1].trim(),
    heading: m[2]?.slice(1),
    alias: m[3]?.trim(),
  }));
}

/**
 * Resolve a link target the way Obsidian does: exact path first, then a note
 * with that title anywhere (shortest path wins).
 */
export function resolveLink(target: string, paths: string[]): string | null {
  const t = target.replace(/^\/+/, '');
  const withExt = /\.(md|markdown|txt)$/i.test(t) ? t : `${t}.md`;
  if (paths.includes(withExt)) return withExt;
  const lower = basename(withExt).toLowerCase();
  const candidates = paths.filter((p) => basename(p).toLowerCase() === lower || noteTitle(p).toLowerCase() === t.toLowerCase());
  if (!candidates.length) return null;
  return candidates.sort((a, b) => a.length - b.length)[0];
}

/** Notes that link to `path`. */
export function backlinks(path: string, paths: string[], read: (p: string) => string | undefined): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (p === path) continue;
    const text = read(p);
    if (text?.includes('[[') && parseWikiLinks(text).some((l) => resolveLink(l.target, paths) === path)) out.push(p);
  }
  return out;
}
