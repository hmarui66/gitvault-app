import { isSyncable } from './paths';

export interface ImportItem {
  path: string;
  content: string;
}

export interface ImportPlan {
  added: ImportItem[];
  /** Same path already in the vault with different content. */
  changed: ImportItem[];
  unchanged: number;
  /** Attachments, .obsidian settings and other files GitVault does not sync. */
  skipped: number;
}

/**
 * Path inside the vault for a picked file. A folder pick reports "VaultName/dir/note.md";
 * the picked folder itself is dropped. A plain multi-file pick has no relative path.
 */
export function vaultRelativePath(file: { name: string; webkitRelativePath?: string }): string {
  const rel = file.webkitRelativePath;
  if (!rel) return file.name;
  const i = rel.indexOf('/');
  return i < 0 ? rel : rel.slice(i + 1);
}

export async function planImport(files: File[], existing: (path: string) => string | undefined): Promise<ImportPlan> {
  const plan: ImportPlan = { added: [], changed: [], unchanged: 0, skipped: 0 };
  for (const file of files) {
    const path = vaultRelativePath(file);
    if (!isSyncable(path)) {
      plan.skipped++;
      continue;
    }
    const content = await file.text();
    const cur = existing(path);
    if (cur === undefined) plan.added.push({ path, content });
    else if (cur === content) plan.unchanged++;
    else plan.changed.push({ path, content });
  }
  return plan;
}
