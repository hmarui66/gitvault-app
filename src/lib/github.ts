export type Head = { kind: 'ok'; sha: string } | { kind: 'empty' } | { kind: 'missing' };

export interface TreeEntry {
  path: string;
  /** New text content, or `null` to delete the path. */
  content: string | null;
}

export interface RemoteBlob {
  path: string;
  sha: string;
}

/** The subset of the GitHub Git Data API that sync needs. */
export interface GitHubLike {
  /** Request count and approximate payload bytes (uncompressed JSON), for metrics. */
  readonly stats?: { requests: number; bytes: number };
  getHead(): Promise<Head>;
  /** Create the first commit in an empty repository; returns its sha. */
  initEmpty(): Promise<string>;
  getCommitTree(commitSha: string): Promise<string>;
  getTree(treeSha: string): Promise<RemoteBlob[]>;
  getBlob(sha: string): Promise<string>;
  createTree(baseTree: string | null, entries: TreeEntry[]): Promise<string>;
  createCommit(message: string, tree: string, parents: string[]): Promise<string>;
  /** Fast-forward the branch; throws NonFastForwardError if someone else pushed first. */
  updateRef(commitSha: string): Promise<void>;
  createRef(commitSha: string): Promise<void>;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`GitHub ${status}: ${message}`);
  }
}

export class NonFastForwardError extends Error {
  constructor() {
    super('Remote branch moved during sync');
  }
}

const API = 'https://api.github.com';
const decoder = new TextDecoder();

function base64ToText(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return decoder.decode(bytes);
}

export class GitHub implements GitHubLike {
  private readonly fetchImpl: typeof fetch;
  readonly stats = { requests: 0, bytes: 0 };

  constructor(
    private readonly cfg: { owner: string; repo: string; branch: string; token: string },
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private get branchPath(): string {
    return this.cfg.branch.split('/').map(encodeURIComponent).join('/');
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    this.stats.requests++;
    this.stats.bytes += payload?.length ?? 0;
    const res = await this.fetchImpl(`${API}/repos/${this.cfg.owner}/${this.cfg.repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: payload,
      // The branch head must never come from the HTTP cache.
      cache: 'no-store',
    });
    const text = await res.text();
    this.stats.bytes += text.length;
    if (!res.ok) {
      let message = res.statusText;
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {
        // non-JSON error body
      }
      throw new GitHubError(res.status, message);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Verifies the token can see the repo; returns its default branch. */
  async checkRepo(): Promise<{ defaultBranch: string; canPush: boolean }> {
    const r = await this.req<{ default_branch: string; permissions?: { push?: boolean } }>('GET', '');
    return { defaultBranch: r.default_branch, canPush: r.permissions?.push ?? false };
  }

  async getHead(): Promise<Head> {
    try {
      const r = await this.req<{ object: { sha: string } }>('GET', `/git/ref/heads/${this.branchPath}`);
      return { kind: 'ok', sha: r.object.sha };
    } catch (e) {
      if (e instanceof GitHubError && e.status === 409) return { kind: 'empty' };
      if (e instanceof GitHubError && e.status === 404) {
        await this.checkRepo(); // rethrows if the repo itself is missing or inaccessible
        return { kind: 'missing' };
      }
      throw e;
    }
  }

  async initEmpty(): Promise<string> {
    // The Git Data API refuses to work on an empty repository; the Contents API can create the first commit.
    const r = await this.req<{ commit: { sha: string } }>('PUT', '/contents/.gitvault', {
      message: 'Initialize vault',
      content: btoa('This repository is a GitVault notes vault.\n'),
      branch: this.cfg.branch,
    });
    return r.commit.sha;
  }

  async getCommitTree(commitSha: string): Promise<string> {
    const r = await this.req<{ tree: { sha: string } }>('GET', `/git/commits/${commitSha}`);
    return r.tree.sha;
  }

  async getTree(treeSha: string): Promise<RemoteBlob[]> {
    const r = await this.req<{ truncated: boolean; tree: { path: string; type: string; sha: string }[] }>(
      'GET',
      `/git/trees/${treeSha}?recursive=1`,
    );
    if (r.truncated) throw new Error('Repository tree is too large for the GitHub API (truncated)');
    return r.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha }));
  }

  async getBlob(sha: string): Promise<string> {
    const r = await this.req<{ content: string; encoding: string }>('GET', `/git/blobs/${sha}`);
    return r.encoding === 'base64' ? base64ToText(r.content) : r.content;
  }

  async createTree(baseTree: string | null, entries: TreeEntry[]): Promise<string> {
    const r = await this.req<{ sha: string }>('POST', '/git/trees', {
      ...(baseTree ? { base_tree: baseTree } : {}),
      tree: entries.map((e) =>
        e.content === null
          ? { path: e.path, mode: '100644', type: 'blob', sha: null }
          : { path: e.path, mode: '100644', type: 'blob', content: e.content },
      ),
    });
    return r.sha;
  }

  async createCommit(message: string, tree: string, parents: string[]): Promise<string> {
    const r = await this.req<{ sha: string }>('POST', '/git/commits', { message, tree, parents });
    return r.sha;
  }

  async updateRef(commitSha: string): Promise<void> {
    try {
      await this.req('PATCH', `/git/refs/heads/${this.branchPath}`, { sha: commitSha, force: false });
    } catch (e) {
      if (e instanceof GitHubError && e.status === 422) throw new NonFastForwardError();
      throw e;
    }
  }

  async createRef(commitSha: string): Promise<void> {
    await this.req('POST', '/git/refs', { ref: `refs/heads/${this.cfg.branch}`, sha: commitSha });
  }
}
