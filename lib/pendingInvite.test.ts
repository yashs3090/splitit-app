import type { KeyValueStorage } from './chunkedStorage';
import {
  PENDING_INVITE_KEY,
  PENDING_INVITE_TTL_MS,
  clearPendingInvite,
  normalizeInviteCode,
  postSignInRoute,
  savePendingInvite,
  takePendingInvite,
} from './pendingInvite';

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
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

const CODE_A = 'abcdefghij12';
const CODE_B = 'ZYXWVUTSRQ_-98';
const T0 = 1_700_000_000_000;

describe('normalizeInviteCode', () => {
  it('accepts 10- and 64-character codes and preserves case', () => {
    expect(normalizeInviteCode('abcDEF_-09')).toBe('abcDEF_-09');
    const sixtyFour = 'A1_-'.repeat(16);
    expect(sixtyFour).toHaveLength(64);
    expect(normalizeInviteCode(sixtyFour)).toBe(sixtyFour);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeInviteCode(`  ${CODE_A}\n`)).toBe(CODE_A);
  });

  it.each([
    ['empty string', ''],
    ['9 characters', 'abcdefghi'],
    ['65 characters', 'a'.repeat(65)],
    ['path traversal', 'abc/../def12'],
    ['percent-encoded slash', 'abcdefghij%2F'],
    ['inner space', 'abcde fghij'],
    ['unicode', 'ábcdefghijk'],
    ['undefined', undefined],
    ['number', 123],
    ['null', null],
    ['array', [CODE_A]],
  ])('rejects %s', (_label, raw) => {
    expect(normalizeInviteCode(raw)).toBeNull();
  });
});

describe('pending invite storage', () => {
  it('save then take returns the code; a second take returns null', async () => {
    const storage = memoryStorage();
    await savePendingInvite(storage, CODE_A, T0);
    expect(await takePendingInvite(storage, T0 + 1000)).toBe(CODE_A);
    expect(await takePendingInvite(storage, T0 + 2000)).toBeNull();
    expect(storage.data.has(PENDING_INVITE_KEY)).toBe(false);
  });

  it('the newest invite overwrites older ones', async () => {
    const storage = memoryStorage();
    await savePendingInvite(storage, CODE_A, T0);
    await savePendingInvite(storage, CODE_B, T0 + 5);
    expect(await takePendingInvite(storage, T0 + 10)).toBe(CODE_B);
  });

  it('stores the normalized code as { code, savedAt } JSON under one key', async () => {
    const storage = memoryStorage();
    await savePendingInvite(storage, `  ${CODE_A} `, T0);
    expect(JSON.parse(storage.data.get(PENDING_INVITE_KEY) ?? 'null')).toEqual({ code: CODE_A, savedAt: T0 });
    expect(storage.data.size).toBe(1);
  });

  it('defaults the TTL to 24 hours', () => {
    expect(PENDING_INVITE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('returns null and removes the key after savedAt + ttl + 1', async () => {
    const storage = memoryStorage();
    await savePendingInvite(storage, CODE_A, T0);
    expect(await takePendingInvite(storage, T0 + PENDING_INVITE_TTL_MS + 1)).toBeNull();
    expect(storage.data.has(PENDING_INVITE_KEY)).toBe(false);
  });

  it('returns the code at exactly savedAt + ttl - 1', async () => {
    const storage = memoryStorage();
    await savePendingInvite(storage, CODE_A, T0);
    expect(await takePendingInvite(storage, T0 + PENDING_INVITE_TTL_MS - 1)).toBe(CODE_A);
  });

  it('honours a custom TTL', async () => {
    const storage = memoryStorage();
    await savePendingInvite(storage, CODE_A, T0);
    expect(await takePendingInvite(storage, T0 + 101, 100)).toBeNull();
  });

  it('returns null for a savedAt in the future (clock skew or tampering) and removes the key', async () => {
    const storage = memoryStorage();
    await savePendingInvite(storage, CODE_A, T0 + 60_000);
    expect(await takePendingInvite(storage, T0)).toBeNull();
    expect(storage.data.has(PENDING_INVITE_KEY)).toBe(false);
  });

  it.each([
    ['corrupt JSON', '{not json'],
    ['JSON null', 'null'],
    ['wrong shape', JSON.stringify({ code: CODE_A })],
    ['non-numeric savedAt', JSON.stringify({ code: CODE_A, savedAt: 'yesterday' })],
    ['code that no longer validates', JSON.stringify({ code: 'https://evil.com', savedAt: T0 })],
  ])('returns null without throwing and removes the key for %s', async (_label, raw) => {
    const storage = memoryStorage();
    storage.data.set(PENDING_INVITE_KEY, raw);
    await expect(takePendingInvite(storage, T0 + 1)).resolves.toBeNull();
    expect(storage.data.has(PENDING_INVITE_KEY)).toBe(false);
  });

  it('returns null without throwing when getItem throws', async () => {
    const storage = memoryStorage();
    storage.getItem = async () => {
      throw new Error('keychain locked');
    };
    await expect(takePendingInvite(storage, T0)).resolves.toBeNull();
  });

  it('still returns the code when removeItem throws after a successful read', async () => {
    const storage = memoryStorage();
    await savePendingInvite(storage, CODE_A, T0);
    storage.removeItem = async () => {
      throw new Error('disk full');
    };
    await expect(takePendingInvite(storage, T0 + 1)).resolves.toBe(CODE_A);
  });

  it('saving an invalid code stores nothing', async () => {
    const storage = memoryStorage();
    await savePendingInvite(storage, 'bad', T0);
    await savePendingInvite(storage, 'abc/../def12', T0);
    expect(storage.data.size).toBe(0);
  });

  it('saving an invalid code does not clobber a valid pending invite', async () => {
    const storage = memoryStorage();
    await savePendingInvite(storage, CODE_A, T0);
    await savePendingInvite(storage, 'bad', T0 + 1);
    expect(await takePendingInvite(storage, T0 + 2)).toBe(CODE_A);
  });

  it('clearPendingInvite removes the entry and never throws', async () => {
    const storage = memoryStorage();
    await savePendingInvite(storage, CODE_A, T0);
    await clearPendingInvite(storage);
    expect(storage.data.size).toBe(0);
    storage.removeItem = async () => {
      throw new Error('boom');
    };
    await expect(clearPendingInvite(storage)).resolves.toBeUndefined();
  });
});

describe('postSignInRoute', () => {
  it('returns /b/<code> for a valid code', () => {
    expect(postSignInRoute(CODE_A)).toBe('/b/abcdefghij12');
  });

  it.each([null, '', 'https://evil.com', '//evil.com', '/b/abcdefghij12', 'abc/../def12'])(
    'returns / for %p',
    (code) => {
      expect(postSignInRoute(code)).toBe('/');
    },
  );
});
