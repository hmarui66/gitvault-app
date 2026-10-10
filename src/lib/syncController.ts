/**
 * Decides *when* to sync. Local saves are continuous; GitHub only sees a commit when
 *  - the user has stopped editing for `autoSyncDelaySec`,
 *  - the app goes to the background (switching apps / turning the screen off),
 *  - the device comes back online, or the app is (re)opened,
 *  - the user taps the status chip.
 * If the page cannot finish (offline, killed), Background Sync lets the service worker retry.
 */
import { getConfig, getSyncState } from './db';
import { flushMetrics, record } from './metrics';
import { BG_SYNC_TAG, runSync, SYNC_CHANNEL, type SyncMessage, type SyncResult, type SyncTrigger } from './sync';
import type { Vault } from './vault';

const RESUME_PULL_INTERVAL_MS = 30_000;

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncView {
  status: SyncStatus;
  lastSyncAt: number | null;
  lastError: string | null;
  lastResult: SyncResult | null;
}

interface SyncRegistration extends ServiceWorkerRegistration {
  sync?: { register(tag: string): Promise<void> };
}

export class SyncController {
  view: SyncView = { status: 'idle', lastSyncAt: null, lastError: null, lastResult: null };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private again = false;
  private listeners = new Set<() => void>();

  constructor(private readonly vault: Vault) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<SyncView>): void {
    this.view = { ...this.view, ...patch };
    for (const fn of this.listeners) fn();
  }

  async start(): Promise<void> {
    const s = await getSyncState();
    this.set({ lastSyncAt: s.lastSyncAt, lastError: s.lastError, status: navigator.onLine ? 'idle' : 'offline' });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.onHidden();
      else if (Date.now() - (this.view.lastSyncAt ?? 0) > RESUME_PULL_INTERVAL_MS) void this.sync('resume');
    });
    window.addEventListener('online', () => void this.sync('online'));
    window.addEventListener('offline', () => this.set({ status: 'offline' }));

    // The service worker (or another tab) may sync on our behalf.
    new BroadcastChannel(SYNC_CHANNEL).addEventListener('message', (e: MessageEvent<SyncMessage>) => {
      if (this.running) return; // our own run, handled in sync()
      if (e.data.type === 'synced') {
        void this.vault.load();
        this.set({ lastSyncAt: Date.now(), lastError: null, lastResult: e.data.result, status: 'idle' });
      }
    });

    void this.sync('startup');
  }

  /** Called on every edit: (re)arm the idle timer. */
  async noteEdited(): Promise<void> {
    clearTimeout(this.timer);
    const delay = (await getConfig())?.autoSyncDelaySec ?? 0;
    if (delay > 0) this.timer = setTimeout(() => void this.sync('idle'), delay * 1000);
  }

  async sync(trigger: SyncTrigger = 'manual'): Promise<void> {
    clearTimeout(this.timer);
    if (!navigator.onLine) {
      this.set({ status: 'offline' });
      record('sync.deferred', { attrs: { trigger, reason: 'offline', pending: this.vault.dirtyCount } });
      if (this.vault.dirtyCount > 0) void this.requestBackgroundSync();
      return;
    }
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    this.set({ status: 'syncing' });
    try {
      await this.vault.flush();
      const result = await runSync({ trigger });
      await this.vault.load();
      this.set({ status: 'idle', lastSyncAt: Date.now(), lastError: null, lastResult: result });
      if (result.incomplete) this.again = true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.set({ status: navigator.onLine ? 'error' : 'offline', lastError: message });
      if (this.vault.dirtyCount > 0) void this.requestBackgroundSync();
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        void this.sync('retry');
      }
    }
  }

  private async onHidden(): Promise<void> {
    await this.vault.flush();
    void flushMetrics();
    if (this.vault.dirtyCount === 0) return;
    // Register first: if the browser freezes us mid-request, the service worker finishes the job.
    // If our own sync completes, the background run finds nothing to do.
    await this.requestBackgroundSync();
    void this.sync('hidden');
  }

  private async requestBackgroundSync(): Promise<void> {
    try {
      const reg = (await navigator.serviceWorker?.ready) as SyncRegistration | undefined;
      if (!reg?.sync) return;
      await reg.sync.register(BG_SYNC_TAG);
      record('bgsync.register', { attrs: { pending: this.vault.dirtyCount } });
    } catch {
      // Background Sync unsupported or denied; the next foreground trigger will sync.
    }
  }
}
