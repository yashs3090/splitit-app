import { createChunkedStorage, type KeyValueStorage } from './chunkedStorage';

function memoryBacking(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => {
      data.set(k, v);
    },
    removeItem: async (k) => {
      data.delete(k);
    },
  };
}

const keysFor = (data: Map<string, string>, key: string) =>
  [...data.keys()].filter((k) => k === key || k.startsWith(`${key}.`));

describe('createChunkedStorage', () => {
  it('round-trips a value of 3x chunkSize intact', async () => {
    const backing = memoryBacking();
    const storage = createChunkedStorage(backing, { chunkSize: 10 });
    const value = 'abcdefghij'.repeat(3);
    await storage.setItem('sess', value);
    expect(await storage.getItem('sess')).toBe(value);
    expect(backing.data.get('sess.count')).toBe('3');
    expect(backing.data.get('sess.0')).toBe('abcdefghij');
  });

  it('round-trips values that are not a multiple of chunkSize, and the empty string', async () => {
    const storage = createChunkedStorage(memoryBacking(), { chunkSize: 4 });
    await storage.setItem('a', 'hello world');
    expect(await storage.getItem('a')).toBe('hello world');
    await storage.setItem('b', '');
    expect(await storage.getItem('b')).toBe('');
  });

  it('removeItem leaves no <key>.* entries', async () => {
    const backing = memoryBacking();
    const storage = createChunkedStorage(backing, { chunkSize: 5 });
    await storage.setItem('sess', 'x'.repeat(23));
    await storage.setItem('other', 'keep me');
    await storage.removeItem('sess');
    expect(keysFor(backing.data, 'sess')).toEqual([]);
    expect(await storage.getItem('sess')).toBeNull();
    expect(await storage.getItem('other')).toBe('keep me');
  });

  it('overwriting a long value with a short one leaves no stale chunks', async () => {
    const backing = memoryBacking();
    const storage = createChunkedStorage(backing, { chunkSize: 5 });
    await storage.setItem('sess', 'y'.repeat(25));
    await storage.setItem('sess', 'short');
    expect(await storage.getItem('sess')).toBe('short');
    expect(keysFor(backing.data, 'sess').sort()).toEqual(['sess.0', 'sess.count']);
  });

  it('returns null for a missing key', async () => {
    const storage = createChunkedStorage(memoryBacking(), { chunkSize: 5 });
    expect(await storage.getItem('nope')).toBeNull();
  });

  it('returns null when a chunk is missing or the count is corrupt', async () => {
    const backing = memoryBacking();
    const storage = createChunkedStorage(backing, { chunkSize: 5 });
    await storage.setItem('sess', 'z'.repeat(12));
    backing.data.delete('sess.1');
    expect(await storage.getItem('sess')).toBeNull();
    backing.data.set('sess.count', 'banana');
    expect(await storage.getItem('sess')).toBeNull();
  });

  it('rejects a non-positive chunkSize', () => {
    expect(() => createChunkedStorage(memoryBacking(), { chunkSize: 0 })).toThrow();
  });
});
