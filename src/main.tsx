import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';
import { getConfig } from './lib/db';
import { record } from './lib/metrics';
import { SyncController } from './lib/syncController';
import { vault } from './lib/vault';
import { App } from './ui/App';
import './styles.css';

const updateSW = registerSW({
  onNeedRefresh() {
    const bar = document.createElement('button');
    bar.className = 'update-bar';
    bar.textContent = '新しいバージョンがあります — タップして更新';
    bar.onclick = async () => {
      record('app.update');
      await vault.flush();
      await updateSW(true);
    };
    document.body.append(bar);
  },
});

async function boot() {
  // Ask the browser not to evict our IndexedDB under storage pressure (unsynced notes live there).
  void navigator.storage?.persist?.();

  const config = await getConfig();
  const sync = new SyncController(vault);
  if (config) {
    vault.deviceName = config.deviceName;
    await vault.load();
    void sync.start();
  }
  render(<App initialConfig={config} sync={sync} />, document.getElementById('app')!);
  // Time from navigation start until the vault is loaded and the first render is done.
  record('app.start', {
    ms: performance.now(),
    attrs: { notes: vault.paths().length, online: navigator.onLine ? 1 : 0, sw: navigator.serviceWorker?.controller ? 1 : 0 },
  });
}

void boot();
