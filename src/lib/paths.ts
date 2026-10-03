const SYNCABLE_EXT = /\.(md|markdown|txt)$/i;

/** Only plain-text notes are synced; dot-folders (.obsidian, .github, ...) are left untouched on the remote. */
export function isSyncable(path: string): boolean {
  return SYNCABLE_EXT.test(path) && !path.split('/').some((seg) => seg.startsWith('.') || seg === '');
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** "folder/My Note.md" -> "My Note" */
export function noteTitle(path: string): string {
  return basename(path).replace(SYNCABLE_EXT, '');
}

/** Normalize user input into a vault path: trims, strips leading slashes, adds .md. */
export function normalizeNotePath(input: string): string {
  let p = input.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  if (!SYNCABLE_EXT.test(p)) p += '.md';
  return p;
}

export function conflictCopyPath(path: string, device: string, date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
  const m = path.match(SYNCABLE_EXT);
  const ext = m ? m[0] : '.md';
  const stem = path.slice(0, path.length - ext.length);
  const safeDevice = device.replace(/[\\/:*?"<>|]/g, '-');
  return `${stem} (conflict ${safeDevice} ${stamp})${ext}`;
}
