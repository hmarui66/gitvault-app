import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { deleteDatabase, getDB, writeFile } from '../src/lib/db';
import { Vault } from '../src/lib/vault';

let v: Vault;

async function stored(path: string) {
  return (await (await getDB()).get('files', path))?.content;
}

beforeEach(async () => {
  await deleteDatabase();
  v = new Vault();
  v.deviceName = 'Pixel';
});

describe('Vault', () => {
  it('keeps edits in memory and persists them on flush', async () => {
    v.write('a.md', 'hello');
    expect(v.read('a.md')).toBe('hello');
    expect(v.dirtyCount).toBe(1);
    await v.flush();
    expect(await stored('a.md')).toBe('hello');
  });

  it('merges an unsaved edit with content sync wrote underneath it', async () => {
    await v.create('a.md', 'one\ntwo\nthree\n');
    v.write('a.md', 'ONE\ntwo\nthree\n'); // pending in memory
    await writeFile('a.md', 'one\ntwo\nTHREE\n'); // sync pulled a remote edit
    const external: string[][] = [];
    v.subscribe((e) => e.type === 'external' && external.push(e.paths));
    await v.flush();
    expect(await stored('a.md')).toBe('ONE\ntwo\nTHREE\n');
    expect(v.read('a.md')).toBe('ONE\ntwo\nTHREE\n');
    expect(external).toEqual([['a.md']]);
  });

  it('keeps a conflict copy when the unsaved edit cannot be merged', async () => {
    await v.create('a.md', 'line\n');
    v.write('a.md', 'mine\n');
    await writeFile('a.md', 'theirs\n');
    await v.flush();
    expect(v.read('a.md')).toBe('theirs\n');
    const copy = v.paths().find((p) => p.includes('conflict'))!;
    expect(v.read(copy)).toBe('mine\n');
    expect(await stored(copy)).toBe('mine\n');
  });

  it('load() does not clobber a note with a pending edit', async () => {
    await v.create('a.md', 'x');
    v.write('a.md', 'typing');
    await writeFile('a.md', 'remote');
    await v.load();
    expect(v.read('a.md')).toBe('typing');
  });

  it('imports many notes at once, overwriting existing ones', async () => {
    await v.create('a.md', 'old');
    await v.importNotes([
      { path: 'a.md', content: 'new' },
      { path: 'dir/b.md', content: 'B' },
    ]);
    expect(v.paths()).toEqual(['a.md', 'dir/b.md']);
    expect(await stored('a.md')).toBe('new');
    expect(v.dirtyCount).toBe(2);
  });
});
