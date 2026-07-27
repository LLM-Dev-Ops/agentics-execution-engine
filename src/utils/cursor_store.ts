import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CursorStore } from '../ruvector_client.js';

export class FileCursorStore implements CursorStore {
  constructor(private readonly path: string) {}

  async read(): Promise<string | null> {
    try {
      const raw = await readFile(this.path, 'utf-8');
      const trimmed = raw.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async write(cursor: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, cursor, 'utf-8');
    await rename(tmp, this.path);
  }
}
