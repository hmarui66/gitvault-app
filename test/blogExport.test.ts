import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { buildBlogPost, defaultBlogMeta, parseFrontmatter, parseTags, validateBlogMeta } from '../src/lib/blogExport';

/** Parse the generated frontmatter the way Astro does (@astrojs/internal-helpers: js-yaml 4 `load`). */
function front(text: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error('no frontmatter');
  return load(m[1]) as Record<string, unknown>;
}

const meta = { title: 'ブログを再開', date: '2026-01-19', description: '', tags: [] as string[], draft: false };

describe('buildBlogPost', () => {
  it('produces the blog frontmatter format', () => {
    const { text } = buildBlogPost('本文です。\n', { ...meta, description: '説明', tags: ['essay'] }, { dropTitleHeading: false });
    expect(text).toBe('---\ntitle: "ブログを再開"\ndate: 2026-01-19\ndescription: "説明"\ntags: ["essay"]\n---\n\n本文です。\n');
  });

  it('yields values that match the content schema when parsed like Astro', () => {
    const tricky = { ...meta, title: 'He said "yes": 50% \\ #1', description: 'line: with colon', tags: ['db', 'C#'], draft: true };
    const data = front(buildBlogPost('x', tricky, { dropTitleHeading: false }).text);
    expect(data.title).toBe(tricky.title);
    expect(data.date).toBeInstanceOf(Date); // z.date()
    expect((data.date as Date).toISOString().slice(0, 10)).toBe('2026-01-19');
    expect(data.description).toBe('line: with colon');
    expect(data.tags).toEqual(['db', 'C#']);
    expect(data.draft).toBe(true);
  });

  it('omits optional fields when empty', () => {
    const data = front(buildBlogPost('x', meta, { dropTitleHeading: false }).text);
    expect(Object.keys(data)).toEqual(['title', 'date']);
  });

  it('replaces existing properties, drops the title heading and Obsidian-only syntax', () => {
    const src = '---\ntags: [memo]\n---\n# タイトル\n\n[[Other note|別ノート]]と[[B-Link Tree]]を参照。%%内部メモ%%\n![[diagram.png]]\n';
    const post = buildBlogPost(src, meta, { dropTitleHeading: true });
    expect(post.text).toBe('---\ntitle: "ブログを再開"\ndate: 2026-01-19\n---\n\n別ノートとB-Link Treeを参照。\n');
    expect(post.changes).toHaveLength(5);
  });

  it('keeps a leading heading unless asked to drop it', () => {
    expect(buildBlogPost('# H\n\nbody', meta, { dropTitleHeading: false }).text).toContain('\n# H\n\nbody\n');
  });
});

describe('defaultBlogMeta', () => {
  const now = new Date(2026, 9, 26);
  it('prefills from note properties', () => {
    const src = '---\ntitle: "From props"\ndate: 2026-10-01\ndescription: desc\ntags:\n  - db\n  - "#lsm"\n---\nbody';
    expect(defaultBlogMeta(src, 'a.md', now)).toEqual({ title: 'From props', date: '2026-10-01', description: 'desc', tags: ['db', 'lsm'], draft: false });
  });
  it('falls back to the first heading, then the file name, and today', () => {
    expect(defaultBlogMeta('\n# 見出し\n本文', 'x/note.md', now)).toMatchObject({ title: '見出し', date: '2026-10-26', tags: [] });
    expect(defaultBlogMeta('本文', 'x/ノート名.md', now).title).toBe('ノート名');
  });
});

describe('helpers', () => {
  it('parses tags typed with commas, spaces or #', () => {
    expect(parseTags('essay, #db  db、本')).toEqual(['essay', 'db', '本']);
  });
  it('validates required fields', () => {
    expect(validateBlogMeta(meta)).toEqual([]);
    expect(validateBlogMeta({ ...meta, title: ' ', date: '2026-02-30' })).toHaveLength(2);
  });
  it('treats a note without properties as all body', () => {
    expect(parseFrontmatter('no props')).toEqual({ data: {}, body: 'no props' });
  });
});
