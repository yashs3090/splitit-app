/** The async key/value interface supabase-js expects for `auth.storage`. */
export type KeyValueStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

/**
 * Wraps a size-limited store (e.g. SecureStore) so long values are split across
 * `<key>.0 .. <key>.<n-1>`, with the chunk count stored under `<key>.count`.
 */
export function createChunkedStorage(backing: KeyValueStorage, options: { chunkSize: number }): KeyValueStorage {
  const { chunkSize } = options;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error('chunkSize must be a positive integer');
  }

  const countKey = (key: string) => `${key}.count`;
  const chunkKey = (key: string, i: number) => `${key}.${i}`;

  async function readCount(key: string): Promise<number | null> {
    const raw = await backing.getItem(countKey(key));
    if (raw === null || !/^\d+$/.test(raw)) return null;
    return Number(raw);
  }

  return {
    async getItem(key) {
      const count = await readCount(key);
      if (count === null) return null;
      const parts: string[] = [];
      for (let i = 0; i < count; i++) {
        const part = await backing.getItem(chunkKey(key, i));
        if (part === null) return null; // Incomplete write: treat as missing.
        parts.push(part);
      }
      return parts.join('');
    },

    async setItem(key, value) {
      const oldCount = (await readCount(key)) ?? 0;
      const chunks: string[] = [];
      for (let i = 0; i < value.length; i += chunkSize) chunks.push(value.slice(i, i + chunkSize));
      if (chunks.length === 0) chunks.push('');

      for (let i = 0; i < chunks.length; i++) {
        await backing.setItem(chunkKey(key, i), chunks[i] ?? '');
      }
      await backing.setItem(countKey(key), String(chunks.length));
      for (let i = chunks.length; i < oldCount; i++) {
        await backing.removeItem(chunkKey(key, i));
      }
    },

    async removeItem(key) {
      const count = (await readCount(key)) ?? 0;
      await backing.removeItem(countKey(key));
      for (let i = 0; i < count; i++) {
        await backing.removeItem(chunkKey(key, i));
      }
    },
  };
}
