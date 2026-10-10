import { gitBlobSha } from '../src/lib/gitBlob';
import { NonFastForwardError, type GitHubLike, type Head, type RemoteBlob, type TreeEntry } from '../src/lib/github';

/** In-memory git remote implementing just enough of the Git Data API semantics. */
export class FakeGitHub implements GitHubLike {
  blobs = new Map<string, string>();
  trees = new Map<string, Map<string, string>>();
  commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  head: string | null = null;
  empty = false;
  calls: string[] = [];
  /** Hook run right before updateRef, to simulate another device pushing concurrently. */
  beforeUpdateRef: (() => Promise<void>) | null = null;
  onGetBlob: ((sha: string) => Promise<void>) | null = null;
  private seq = 0;

  /** Commit a set of files directly on the remote, as another device would. */
  async commitFiles(changes: Record<string, string | null>, message = 'remote edit'): Promise<string> {
    const base = this.head ? this.commits.get(this.head)!.tree : null;
    const tree = await this.createTree(
      base,
      Object.entries(changes).map(([path, content]) => ({ path, content })),
    );
    const commit = await this.createCommit(message, tree, this.head ? [this.head] : []);
    this.head = commit;
    this.empty = false;
    return commit;
  }

  async read(path: string): Promise<string | undefined> {
    if (!this.head) return undefined;
    const sha = this.trees.get(this.commits.get(this.head)!.tree)!.get(path);
    return sha ? this.blobs.get(sha) : undefined;
  }

  get stats() {
    return { requests: this.calls.length, bytes: 0 };
  }

  get commitCount(): number {
    let n = 0;
    for (let c = this.head; c; c = this.commits.get(c)!.parents[0] ?? null) n++;
    return n;
  }

  async getHead(): Promise<Head> {
    this.calls.push('getHead');
    if (this.empty) return { kind: 'empty' };
    return this.head ? { kind: 'ok', sha: this.head } : { kind: 'missing' };
  }

  async initEmpty(): Promise<string> {
    this.calls.push('initEmpty');
    this.empty = false;
    return this.commitFiles({ '.gitvault': 'init\n' }, 'Initialize vault');
  }

  async getCommitTree(commitSha: string): Promise<string> {
    this.calls.push('getCommitTree');
    return this.commits.get(commitSha)!.tree;
  }

  async getTree(treeSha: string): Promise<RemoteBlob[]> {
    this.calls.push('getTree');
    return [...this.trees.get(treeSha)!].map(([path, sha]) => ({ path, sha }));
  }

  async getBlob(sha: string): Promise<string> {
    this.calls.push('getBlob');
    await this.onGetBlob?.(sha);
    const b = this.blobs.get(sha);
    if (b === undefined) throw new Error(`no blob ${sha}`);
    return b;
  }

  async createTree(baseTree: string | null, entries: TreeEntry[]): Promise<string> {
    this.calls.push('createTree');
    const map = new Map(baseTree ? this.trees.get(baseTree)! : []);
    for (const e of entries) {
      if (e.content === null) {
        if (!map.has(e.path)) throw new Error(`cannot delete missing ${e.path}`);
        map.delete(e.path);
      } else {
        const sha = await gitBlobSha(e.content);
        this.blobs.set(sha, e.content);
        map.set(e.path, sha);
      }
    }
    const sha = `tree${this.seq++}`;
    this.trees.set(sha, map);
    return sha;
  }

  async createCommit(message: string, tree: string, parents: string[]): Promise<string> {
    this.calls.push('createCommit');
    const sha = `commit${this.seq++}`;
    this.commits.set(sha, { tree, parents, message });
    return sha;
  }

  async updateRef(commitSha: string): Promise<void> {
    this.calls.push('updateRef');
    if (this.beforeUpdateRef) {
      const hook = this.beforeUpdateRef;
      this.beforeUpdateRef = null;
      await hook();
    }
    if (this.commits.get(commitSha)!.parents[0] !== this.head) throw new NonFastForwardError();
    this.head = commitSha;
  }

  async createRef(commitSha: string): Promise<void> {
    this.calls.push('createRef');
    this.head = commitSha;
  }
}
