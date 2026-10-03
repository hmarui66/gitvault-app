import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDB, getSyncState, removeFile, deleteDatabase, setConfig, writeFile } from '../src/lib/db';
import { runSync } from '../src/lib/sync';
import { FakeGitHub } from './fakeGitHub';

let gh: FakeGitHub;
const now = () => new Date(2026, 9, 3, 12, 34);
const sync = () => runSync({ github: gh, now });

async function local(path: string): Promise<string | undefined> {
  const f = await (await getDB()).get('files', path);
  return f && !f.deleted ? f.content : undefined;
}

async function localPaths(): Promise<string[]> {
  return (await (await getDB()).getAll('files')).filter((f) => !f.deleted).map((f) => f.path).sort();
}

beforeEach(async () => {
  await deleteDatabase();
  await setConfig({ owner: 'o', repo: 'r', branch: 'main', token: 't', deviceName: 'Pixel', autoSyncDelaySec: 120 });
  gh = new FakeGitHub();
});

describe('sync', () => {
  it('clones only syncable text notes', async () => {
    await gh.commitFiles({ 'a.md': 'A\n', 'dir/b.md': 'B\n', '.obsidian/app.json': '{}', 'img.png': 'x' });
    const r = await sync();
    expect(await localPaths()).toEqual(['a.md', 'dir/b.md']);
    expect(r.pushed).toEqual([]);
    expect((await getSyncState()).lastCommit).toBe(gh.head);
  });

  it('pushes all local changes as a single commit and is idempotent', async () => {
    await gh.commitFiles({ 'a.md': 'A\n' });
    await sync();
    await writeFile('a.md', 'A2\n');
    await writeFile('new.md', 'N\n');
    await writeFile('folder/x.md', 'X\n');
    const before = gh.commitCount;
    const r = await sync();
    expect(r.pushed.sort()).toEqual(['a.md', 'folder/x.md', 'new.md']);
    expect(gh.commitCount).toBe(before + 1);
    expect(await gh.read('a.md')).toBe('A2\n');
    expect(await gh.read('folder/x.md')).toBe('X\n');

    gh.calls = [];
    const again = await sync();
    expect(again.pushed).toEqual([]);
    expect(gh.commitCount).toBe(before + 1);
    // unchanged head: no tree download needed
    expect(gh.calls).toEqual(['getHead']);
  });

  it('keeps non-note files on the remote untouched', async () => {
    await gh.commitFiles({ 'a.md': 'A\n', '.obsidian/app.json': '{}' });
    await sync();
    await writeFile('a.md', 'changed\n');
    await sync();
    expect(await gh.read('.obsidian/app.json')).toBe('{}');
  });

  it('pulls remote edits and deletions', async () => {
    await gh.commitFiles({ 'a.md': 'A\n', 'b.md': 'B\n' });
    await sync();
    await gh.commitFiles({ 'a.md': 'A remote\n', 'b.md': null, 'c.md': 'C\n' });
    const r = await sync();
    expect(r.pulled.sort()).toEqual(['a.md', 'b.md', 'c.md']);
    expect(await local('a.md')).toBe('A remote\n');
    expect(await localPaths()).toEqual(['a.md', 'c.md']);
  });

  it('pushes local deletions', async () => {
    await gh.commitFiles({ 'a.md': 'A\n', 'b.md': 'B\n' });
    await sync();
    await removeFile('b.md');
    await sync();
    expect(await gh.read('b.md')).toBeUndefined();
    expect((await (await getDB()).getAll('files')).map((f) => f.path)).toEqual(['a.md']);
  });

  it('merges concurrent edits to different lines', async () => {
    await gh.commitFiles({ 'a.md': 'one\ntwo\nthree\n' });
    await sync();
    await writeFile('a.md', 'ONE\ntwo\nthree\n');
    await gh.commitFiles({ 'a.md': 'one\ntwo\nTHREE\n' });
    const r = await sync();
    expect(r.conflicts).toEqual([]);
    expect(await local('a.md')).toBe('ONE\ntwo\nTHREE\n');
    expect(await gh.read('a.md')).toBe('ONE\ntwo\nTHREE\n');
  });

  it('keeps both versions when edits conflict', async () => {
    await gh.commitFiles({ 'a.md': 'line\n' });
    await sync();
    await writeFile('a.md', 'mine\n');
    await gh.commitFiles({ 'a.md': 'theirs\n' });
    const r = await sync();
    const copy = 'a (conflict Pixel 2026-10-03 1234).md';
    expect(r.conflicts).toEqual([copy]);
    expect(await local('a.md')).toBe('theirs\n');
    expect(await local(copy)).toBe('mine\n');
    expect(await gh.read('a.md')).toBe('theirs\n');
    expect(await gh.read(copy)).toBe('mine\n');
  });

  it('restores a note deleted here but edited elsewhere', async () => {
    await gh.commitFiles({ 'a.md': 'A\n' });
    await sync();
    await removeFile('a.md');
    await gh.commitFiles({ 'a.md': 'edited\n' });
    await sync();
    expect(await local('a.md')).toBe('edited\n');
    expect(await gh.read('a.md')).toBe('edited\n');
  });

  it('retries when another device pushes mid-sync', async () => {
    await gh.commitFiles({ 'a.md': 'A\n', 'b.md': 'B\n' });
    await sync();
    await writeFile('a.md', 'A local\n');
    gh.beforeUpdateRef = async () => {
      await gh.commitFiles({ 'b.md': 'B remote\n' });
    };
    await sync();
    expect(await gh.read('a.md')).toBe('A local\n');
    expect(await gh.read('b.md')).toBe('B remote\n');
    expect(await local('b.md')).toBe('B remote\n');
  });

  it('never overwrites a local edit made while sync is downloading', async () => {
    await gh.commitFiles({ 'a.md': 'base\n' });
    await sync();
    await gh.commitFiles({ 'a.md': 'remote\n' });
    gh.onGetBlob = async () => {
      gh.onGetBlob = null;
      await writeFile('a.md', 'typed during sync\n');
    };
    const r = await sync();
    expect(r.incomplete).toBe(true);
    expect(await local('a.md')).toBe('typed during sync\n');
    expect((await getSyncState()).lastCommit).toBeNull();

    // The next run sees both sides changed and resolves it as a conflict instead of losing either.
    const r2 = await sync();
    expect(r2.incomplete).toBe(false);
    expect(await gh.read('a.md')).toBe('remote\n');
    expect(r2.conflicts).toHaveLength(1);
    expect(await gh.read(r2.conflicts[0])).toBe('typed during sync\n');
  });

  it('initializes an empty repository', async () => {
    gh.empty = true;
    await writeFile('first.md', 'hello\n');
    await sync();
    expect(gh.calls).toContain('initEmpty');
    expect(await gh.read('first.md')).toBe('hello\n');
  });

  it('creates the branch when it does not exist', async () => {
    await writeFile('first.md', 'hello\n');
    await sync();
    expect(gh.calls).toContain('createRef');
    expect(await gh.read('first.md')).toBe('hello\n');
  });
});
