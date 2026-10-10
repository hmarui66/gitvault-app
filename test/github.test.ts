import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { gitBlobSha } from '../src/lib/gitBlob';
import { GitHub, NonFastForwardError } from '../src/lib/github';

function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const { status, body } = handler(url, init);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, gh: new GitHub({ owner: 'o', repo: 'r', branch: 'main', token: 'T' }, fetchImpl) };
}

describe('GitHub client', () => {
  it('reads the head without HTTP caching and with auth', async () => {
    const { gh, calls } = mockFetch(() => ({ status: 200, body: { object: { sha: 'abc' } } }));
    expect(await gh.getHead()).toEqual({ kind: 'ok', sha: 'abc' });
    expect(calls[0].url).toBe('https://api.github.com/repos/o/r/git/ref/heads/main');
    expect(calls[0].init.cache).toBe('no-store');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer T');
  });

  it('distinguishes an empty repo from a missing branch', async () => {
    expect(await mockFetch(() => ({ status: 409, body: { message: 'Git Repository is empty.' } })).gh.getHead()).toEqual({ kind: 'empty' });
    const missing = mockFetch((url) => (url.endsWith('/repos/o/r') ? { status: 200, body: { default_branch: 'main' } } : { status: 404 }));
    expect(await missing.gh.getHead()).toEqual({ kind: 'missing' });
    const noRepo = mockFetch(() => ({ status: 404, body: { message: 'Not Found' } }));
    await expect(noRepo.gh.getHead()).rejects.toThrow('GitHub 404: Not Found');
  });

  it('decodes UTF-8 blobs', async () => {
    const b64 = Buffer.from('日本語のノート\n').toString('base64').replace(/(.{8})/g, '$1\n');
    const { gh } = mockFetch(() => ({ status: 200, body: { content: b64, encoding: 'base64' } }));
    expect(await gh.getBlob('x')).toBe('日本語のノート\n');
  });

  it('keeps a BOM so the local hash matches the remote blob SHA', async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 見出し\r\n')]);
    const remoteSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    const { gh } = mockFetch(() => ({ status: 200, body: { content: bytes.toString('base64'), encoding: 'base64' } }));
    const text = await gh.getBlob(remoteSha);
    expect(text.startsWith('\uFEFF')).toBe(true);
    expect(await gitBlobSha(text)).toBe(remoteSha);
  });

  it('sends inline content and sha:null deletions in one tree', async () => {
    const { gh, calls } = mockFetch(() => ({ status: 201, body: { sha: 't1' } }));
    await gh.createTree('base', [
      { path: 'a.md', content: 'A' },
      { path: 'b.md', content: null },
    ]);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      base_tree: 'base',
      tree: [
        { path: 'a.md', mode: '100644', type: 'blob', content: 'A' },
        { path: 'b.md', mode: '100644', type: 'blob', sha: null },
      ],
    });
  });

  it('maps a rejected fast-forward to NonFastForwardError', async () => {
    const { gh, calls } = mockFetch(() => ({ status: 422, body: { message: 'Update is not a fast forward' } }));
    await expect(gh.updateRef('c')).rejects.toBeInstanceOf(NonFastForwardError);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ sha: 'c', force: false });
  });
});
