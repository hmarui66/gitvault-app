import { describe, expect, it } from 'vitest';
import { merge3 } from '../src/lib/merge';
import { gitBlobSha } from '../src/lib/gitBlob';
import { conflictCopyPath, isSyncable } from '../src/lib/paths';

describe('merge3', () => {
  it('merges non-overlapping edits', () => {
    expect(merge3('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n')).toEqual({ clean: true, text: 'A\nb\nC\n' });
  });
  it('treats identical edits as clean', () => {
    expect(merge3('a\n', 'b\nx\n', 'b\nx\n')).toEqual({ clean: true, text: 'b\nx\n' });
  });
  it('reports overlapping edits', () => {
    expect(merge3('a\n', 'b\n', 'c\n')).toEqual({ clean: false });
  });
  it('handles a missing trailing newline', () => {
    expect(merge3('a\nb', 'A\nb', 'a\nb\nc')).toEqual({ clean: true, text: 'A\nb\nc' });
  });
});

describe('gitBlobSha', () => {
  it('matches git hash-object', async () => {
    // printf 'hello\n' | git hash-object --stdin
    expect(await gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    // multi-byte content is hashed as UTF-8
    expect(await gitBlobSha('日本語\n')).toHaveLength(40);
  });
});

describe('paths', () => {
  it('syncs only notes outside dot-folders', () => {
    expect(isSyncable('a.md')).toBe(true);
    expect(isSyncable('dir/日記.md')).toBe(true);
    expect(isSyncable('.obsidian/x.md')).toBe(false);
    expect(isSyncable('img.png')).toBe(false);
  });
  it('names conflict copies next to the original', () => {
    expect(conflictCopyPath('d/n.md', 'My/Pixel', new Date(2026, 0, 2, 3, 4))).toBe('d/n (conflict My-Pixel 2026-01-02 0304).md');
  });
});
