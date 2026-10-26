/**
 * Convert a note into a post for the hmarui66.github.io Astro blog.
 * Frontmatter follows its content schema (src/content.config.ts):
 *   title: string, date: date, description?: string, tags?: string[], draft: boolean (default false)
 * Nothing is written back to the vault; the result is only for copying.
 */
import { noteTitle } from './paths';
import { formatDate } from './template';
import { WIKILINK_RE } from './links';

export interface BlogMeta {
  title: string;
  /** "YYYY-MM-DD" */
  date: string;
  description: string;
  tags: string[];
  draft: boolean;
}

export interface BlogOptions {
  /** Drop a leading "# heading" (the blog layout renders the title itself). */
  dropTitleHeading: boolean;
}

export interface BlogPost {
  text: string;
  /** Human-readable notes about what was changed in the body. */
  changes: string[];
}

type FrontValue = string | string[];

const unquote = (v: string) => {
  const t = v.trim();
  if (/^".*"$/.test(t)) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  return /^'.*'$/.test(t) ? t.slice(1, -1).replace(/''/g, "'") : t;
};

/**
 * Minimal reader for Obsidian-style properties: `key: value`, `key: [a, b]` and
 * `key:` followed by `  - item` lines. Enough to prefill the form; anything else is ignored.
 */
export function parseFrontmatter(src: string): { data: Record<string, FrontValue>; body: string } {
  const text = src.replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, FrontValue> = {};
  let listKey: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (item && listKey) {
      (data[listKey] as string[]).push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, raw] = kv;
    listKey = null;
    if (raw === '') {
      data[key] = [];
      listKey = key;
    } else if (/^\[.*\]$/.test(raw.trim())) {
      data[key] = raw.trim().slice(1, -1).split(',').map(unquote).filter(Boolean);
    } else {
      data[key] = unquote(raw);
    }
  }
  return { data, body: text.slice(m[0].length) };
}

const firstHeading = (body: string) => /^\s*#\s+(.+?)\s*#*\s*$/m.exec(body.split('\n').find((l) => l.trim()) ?? '')?.[1];

/** Prefill the form from the note's properties, first heading, file name and today's date. */
export function defaultBlogMeta(src: string, path: string, now = new Date()): BlogMeta {
  const { data, body } = parseFrontmatter(src);
  const str = (k: string) => (typeof data[k] === 'string' ? (data[k] as string) : '');
  const list = (k: string) => (Array.isArray(data[k]) ? (data[k] as string[]) : str(k) ? str(k).split(/[,\s]+/) : []);
  const date = /^\d{4}-\d{2}-\d{2}/.exec(str('date'))?.[0] ?? formatDate(now, 'YYYY-MM-DD');
  return {
    title: str('title') || firstHeading(body) || noteTitle(path),
    date,
    description: str('description'),
    tags: list('tags').map((t) => t.replace(/^#/, '')).filter(Boolean),
    draft: str('draft') === 'true',
  };
}

/** Validation errors for fields the blog schema would reject; empty when OK. */
export function validateBlogMeta(meta: BlogMeta): string[] {
  const errors: string[] = [];
  if (!meta.title.trim()) errors.push('タイトルは必須です');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(meta.date);
  const d = m && new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!m || !d || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) errors.push('日付は YYYY-MM-DD 形式で指定してください');
  return errors;
}

/** Tags typed as "a, b c" or "#a #b". */
export function parseTags(input: string): string[] {
  return [...new Set(input.split(/[,\s、]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean))];
}

// JSON strings are valid YAML double-quoted scalars, matching the blog's existing style.
const q = (s: string) => JSON.stringify(s);

export function buildBlogPost(src: string, meta: BlogMeta, opts: BlogOptions): BlogPost {
  const changes: string[] = [];
  let { body } = parseFrontmatter(src);
  if (body !== src.replace(/^﻿/, '')) changes.push('ノートのプロパティ（frontmatter）を置き換えました');

  if (opts.dropTitleHeading) {
    const next = body.replace(/^\s*#\s+[^\n]*\n?/, '');
    if (next !== body && /^\s*#\s/.test(body)) {
      body = next;
      changes.push('先頭の見出しを削除しました（タイトルはブログ側で表示されます）');
    }
  }

  // Comments (%%...%%) are Obsidian-only and must not leak into a published post.
  const comments = body.match(/%%[\s\S]*?%%/g)?.length ?? 0;
  if (comments) {
    body = body.replace(/%%[\s\S]*?%%/g, '');
    changes.push(`Obsidian のコメント（%%…%%）を ${comments} 件削除しました`);
  }

  // Wikilinks point into the vault, which the blog cannot resolve: keep the visible text.
  let embeds = 0;
  let links = 0;
  body = body.replace(new RegExp(`(!?)${WIKILINK_RE.source}`, 'g'), (_m, bang: string, target: string, _h, alias?: string) => {
    if (bang) {
      embeds++;
      return '';
    }
    links++;
    return (alias ?? target).trim();
  });
  if (links) changes.push(`ノート間リンク [[…]] を ${links} 件、テキストに置き換えました`);
  if (embeds) changes.push(`埋め込み ![[…]] を ${embeds} 件削除しました（画像は public/images/posts/ に置いて通常の画像記法で参照してください）`);

  const header = [
    '---',
    `title: ${q(meta.title.trim())}`,
    `date: ${meta.date}`,
    ...(meta.description.trim() ? [`description: ${q(meta.description.trim())}`] : []),
    ...(meta.tags.length ? [`tags: [${meta.tags.map(q).join(', ')}]`] : []),
    ...(meta.draft ? ['draft: true'] : []),
    '---',
  ].join('\n');

  return { text: `${header}\n\n${body.replace(/^\s*\n/, '').replace(/\s*$/, '')}\n`, changes };
}
