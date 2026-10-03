/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { BG_SYNC_TAG, runSync } from './lib/sync';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<string | { url: string; revision: string | null }> };

interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
  readonly lastChance: boolean;
}

// App shell: everything the app needs to start offline.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

// Background Sync: the page registered this when it went to the background (or failed offline)
// with unsynced changes. The browser fires it once connectivity is available, even if the app is closed.
self.addEventListener('sync', (event) => {
  const e = event as SyncEvent;
  if (e.tag !== BG_SYNC_TAG) return;
  // Rejecting makes the browser retry later with backoff.
  e.waitUntil(runSync().then(() => undefined));
});
