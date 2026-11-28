// Check-in rules for "Sent via Venmo" (docs/specs/2026-11-26-sent-via-venmo.md § D3, Task 5;
// criteria 25, 26, 27, 51, 52). Pure rules, plus the answers blob read/write through an injected
// storage, so nothing here touches expo-notifications or SecureStore.
import type { KeyValueStorage } from './chunkedStorage';
import {
  DEVICE_KEY_RE,
  NOTIF_ASKED_KEY,
  SENT_CHECK_ACTIONS,
  SENT_CHECK_CATEGORY_ID,
  SENT_CHECK_DELAY_SECONDS,
  SENT_CHECK_INLINE_MAX_MINUTES,
  SENT_CHECK_KEEP_MS,
  SENT_CHECK_PREVIEW_PLACEHOLDER,
  SENT_CHECK_STORAGE_TIMEOUT_MS,
  type SentCheckBlob,
  type SentCheckMark,
  answerFor,
  isLateOwnSend,
  LATE_SEND_SKEW_MS,
  sentCheckInlineEndsInMs,
  markAtMsOf,
  parseSentCheckBlob,
  parseSentCheckData,
  payMethodKey,
  pruneSentCheckBlob,
  readSentCheckBlob,
  sentCheckBlobKey,
  sentCheckInline,
  sentCheckKey,
  sentCheckNotification,
  sentCheckNotificationId,
  serializeSentCheckBlob,
  storeSentCheckAnswer,
  undoDecision,
  withAnswer,
} from './sentCheck';

const BILL = '3f2c9a7e-8b1d-4c6e-9f0a-1b2c3d4e5f60';
const SAM = '7d1e2f3a-4b5c-4d6e-8f70-819203a4b5c6';
const HANA = 'c0ffee00-1234-4abc-8def-0123456789ab';
const DEE = 'deadbeef-0000-4000-8000-00000000000d';

const AT = '2026-11-26T19:42:00.123Z';
const AT_MS = Date.parse(AT);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const venmoMark = (over: Partial<SentCheckMark> = {}): SentCheckMark => ({
  cents: 1510,
  at: AT,
  method: 'venmo',
  toUserId: HANA,
  ...over,
});

// ---------------------------------------------------------------------------------------------
describe('constants', () => {
  it('uses the user-chosen 60 s delay and a 30 min inline window', () => {
    expect(SENT_CHECK_DELAY_SECONDS).toBe(60);
    expect(SENT_CHECK_INLINE_MAX_MINUTES).toBe(30);
    expect(SENT_CHECK_KEEP_MS).toBe(2 * DAY);
  });
});

// ---------------------------------------------------------------------------------------------
describe('device keys (criterion 51, A1 F1)', () => {
  it('builds each key in the documented shape', () => {
    expect(sentCheckKey(BILL, HANA, AT_MS)).toBe(`${BILL}.${HANA}.${AT_MS}`);
    expect(sentCheckNotificationId(SAM, BILL, HANA, AT_MS)).toBe(`sentcheck.${SAM}.${BILL}.${HANA}.${AT_MS}`);
    expect(sentCheckBlobKey(SAM)).toBe(`splitit.sentcheck.v1.${SAM}`);
    expect(payMethodKey(SAM)).toBe(`splitit.payMethod.v1.${SAM}`);
    expect(NOTIF_ASKED_KEY).toBe('splitit.notifAsked.v1');
  });

  it('every builder matches /^[\\w.-]+$/ with real UUIDs (100 random sets)', () => {
    expect(DEVICE_KEY_RE.source).toBe('^[\\w.-]+$');
    expect(NOTIF_ASKED_KEY).toMatch(/^[\w.-]+$/);
    for (let i = 0; i < 100; i++) {
      const [u, b, p] = [randomUUID(), randomUUID(), randomUUID()];
      const ms = Math.floor(uuidRand() * 4_102_444_800_000); // up to 2100
      const keys = [sentCheckKey(b, p, ms), sentCheckNotificationId(u, b, p, ms), sentCheckBlobKey(u), payMethodKey(u)];
      for (const k of keys) {
        expect(k).not.toBeNull();
        expect(k).toMatch(/^[\w.-]+$/);
      }
    }
  });

  it('also matches with upper-case UUIDs and a mark at the epoch', () => {
    const up = BILL.toUpperCase();
    expect(sentCheckKey(up, HANA.toUpperCase(), 0)).toMatch(/^[\w.-]+$/);
  });

  it.each<[string, unknown]>([
    ['a colon', 'a:b'],
    ['a slash', `${BILL}/x`],
    ['a space', `${BILL} `],
    ['empty', ''],
    ['not a uuid', 'hana'],
    ['a uuid with a colon suffix', `${BILL}:1`],
    ['unicode', 'ü'.repeat(36)],
    ['a number', 7],
    ['null', null],
    ['undefined', undefined],
  ])('returns null instead of an invalid key for an id with %s', (_label, bad) => {
    const id = bad as string;
    expect(sentCheckKey(id, HANA, AT_MS)).toBeNull();
    expect(sentCheckKey(BILL, id, AT_MS)).toBeNull();
    expect(sentCheckNotificationId(id, BILL, HANA, AT_MS)).toBeNull();
    expect(sentCheckNotificationId(SAM, id, HANA, AT_MS)).toBeNull();
    expect(sentCheckNotificationId(SAM, BILL, id, AT_MS)).toBeNull();
    expect(sentCheckBlobKey(id)).toBeNull();
    expect(payMethodKey(id)).toBeNull();
  });

  it.each<[string, unknown]>([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a fraction', 1.5],
    ['a negative', -1],
    ['a string', String(AT_MS)],
    ['above the safe range', Number.MAX_SAFE_INTEGER + 2],
  ])('returns null for a markAtMs that is %s', (_label, bad) => {
    expect(sentCheckKey(BILL, HANA, bad as number)).toBeNull();
    expect(sentCheckNotificationId(SAM, BILL, HANA, bad as number)).toBeNull();
  });

  it('never returns a string that fails the pattern, whatever it is given (seeded fuzz)', () => {
    const rand = mulberry32(51);
    const alphabet = 'abcdef0123456789-:/._ ü\n';
    const junk = () =>
      rand() < 0.3
        ? randomUUID()
        : Array.from({ length: Math.floor(rand() * 40) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');
    for (let i = 0; i < 500; i++) {
      const ms = rand() < 0.5 ? Math.floor(rand() * 1e13) : rand() * 1e13 - 5e12;
      for (const k of [sentCheckKey(junk(), junk(), ms), sentCheckNotificationId(junk(), junk(), junk(), ms), sentCheckBlobKey(junk()), payMethodKey(junk())]) {
        if (k !== null) expect(k).toMatch(/^[\w.-]+$/);
      }
    }
  });

  it('markAtMsOf: Date.parse of settled_at, or null when it cannot be parsed', () => {
    expect(markAtMsOf(AT)).toBe(AT_MS);
    expect(markAtMsOf('2026-11-26T19:42:00.123+00:00')).toBe(AT_MS); // the DB's form, same number
    expect(markAtMsOf('not a time')).toBeNull();
    expect(markAtMsOf('')).toBeNull();
    expect(markAtMsOf(5 as unknown as string)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe('answers blob: parse, precedence and prune (criterion 51)', () => {
  const KEY = `${BILL}.${HANA}.${AT_MS}`;
  const NOW = AT_MS + 5 * MIN;

  it('reads a well-formed blob', () => {
    const raw = JSON.stringify({ [KEY]: { a: 'yes', t: NOW } });
    expect(parseSentCheckBlob(raw)).toEqual({ [KEY]: { a: 'yes', t: NOW } });
    expect(answerFor(parseSentCheckBlob(raw), KEY)).toBe('yes');
    expect(answerFor(parseSentCheckBlob(raw), `${BILL}.${HANA}.1`)).toBeNull();
  });

  it.each<[string, string | null | undefined]>([
    ['null (nothing stored)', null],
    ['undefined', undefined],
    ['empty', ''],
    ['not JSON', '{oops'],
    ['an array', '[1,2]'],
    ['a string', '"yes"'],
    ['a number', '7'],
    ['JSON null', 'null'],
  ])('a malformed blob (%s) reads as empty', (_label, raw) => {
    expect(parseSentCheckBlob(raw)).toEqual({});
  });

  it('drops malformed entries and keeps the good ones', () => {
    const raw = JSON.stringify({
      [KEY]: { a: 'undo', t: NOW },
      'bad:key': { a: 'yes', t: NOW },
      [`${BILL}.${HANA}.2`]: { a: 'maybe', t: NOW },
      [`${BILL}.${HANA}.3`]: { a: 'yes', t: '1' },
      [`${BILL}.${HANA}.4`]: { a: 'yes' },
      [`${BILL}.${HANA}.5`]: 'yes',
      [`${BILL}.${HANA}.6`]: { a: 'shown', t: NOW, extra: 'https://evil.example' },
    });
    expect(parseSentCheckBlob(raw)).toEqual({ [KEY]: { a: 'undo', t: NOW } });
  });

  it('a key that is a prototype name is never read as an answer', () => {
    expect(answerFor({}, '__proto__')).toBeNull();
    expect(answerFor({}, 'constructor')).toBeNull();
    expect(answerFor(parseSentCheckBlob('{"__proto__":{"a":"yes","t":1}}'), '__proto__')).toBeNull();
  });

  it("precedence: 'undo' beats 'yes'; neither is overwritten by 'shown'; 'yes' and 'undo' beat 'shown'", () => {
    const at = (blob: SentCheckBlob) => answerFor(blob, KEY);
    let b: SentCheckBlob = {};
    b = withAnswer(b, KEY, 'shown', NOW);
    expect(at(b)).toBe('shown');
    b = withAnswer(b, KEY, 'yes', NOW);
    expect(at(b)).toBe('yes');
    b = withAnswer(b, KEY, 'shown', NOW);
    expect(at(b)).toBe('yes');
    b = withAnswer(b, KEY, 'undo', NOW);
    expect(at(b)).toBe('undo');
    b = withAnswer(b, KEY, 'yes', NOW);
    expect(at(b)).toBe('undo');
    b = withAnswer(b, KEY, 'shown', NOW);
    expect(at(b)).toBe('undo');
  });

  it("a weaker answer leaves the entry's time alone; a repeat refreshes it", () => {
    let b = withAnswer({}, KEY, 'undo', NOW);
    b = withAnswer(b, KEY, 'shown', NOW + MIN);
    expect(b[KEY]).toEqual({ a: 'undo', t: NOW });
    b = withAnswer(b, KEY, 'undo', NOW + 2 * MIN);
    expect(b[KEY]).toEqual({ a: 'undo', t: NOW + 2 * MIN });
  });

  it('does not mutate the blob it is given', () => {
    const before = Object.freeze({ [KEY]: Object.freeze({ a: 'shown' as const, t: NOW }) });
    const after = withAnswer(before, KEY, 'yes', NOW);
    expect(before[KEY]).toEqual({ a: 'shown', t: NOW });
    expect(after[KEY]).toEqual({ a: 'yes', t: NOW });
  });

  it('refuses a key that is not a valid entry key (no write)', () => {
    const b = withAnswer({}, 'bad:key', 'yes', NOW);
    expect(b).toEqual({});
  });

  it('prunes entries older than 2 days on every write; exactly 2 days old is kept', () => {
    const old = `${BILL}.${HANA}.1`;
    const edge = `${BILL}.${HANA}.2`;
    const blob: SentCheckBlob = { [old]: { a: 'yes', t: NOW - 2 * DAY - 1 }, [edge]: { a: 'undo', t: NOW - 2 * DAY } };
    const after = withAnswer(blob, KEY, 'shown', NOW);
    expect(Object.keys(after).sort()).toEqual([KEY, edge].sort());
    expect(pruneSentCheckBlob(blob, NOW)).toEqual({ [edge]: { a: 'undo', t: NOW - 2 * DAY } });
  });

  it('serialize then parse round-trips', () => {
    const b = withAnswer(withAnswer({}, KEY, 'yes', NOW), `${BILL}.${DEE}.9`, 'undo', NOW);
    expect(parseSentCheckBlob(serializeSentCheckBlob(b))).toEqual(b);
  });
});

// ---------------------------------------------------------------------------------------------
// Fake storage: an in-memory map whose calls can be held open, to test serialisation and timeouts.
function fakeStorage() {
  const map = new Map<string, string>();
  const calls: string[] = [];
  let hold: 'get' | 'set' | null = null;
  let failNext: 'get' | 'set' | null = null;
  const storage: KeyValueStorage = {
    getItem: async (k) => {
      calls.push(`get ${k}`);
      if (failNext === 'get') {
        failNext = null;
        throw new Error('read failed');
      }
      if (hold === 'get') return new Promise<string | null>(() => {});
      return map.get(k) ?? null;
    },
    setItem: async (k, v) => {
      calls.push(`set ${k}`);
      if (failNext === 'set') {
        failNext = null;
        throw new Error('write failed');
      }
      if (hold === 'set') return new Promise<void>(() => {});
      map.set(k, v);
    },
    removeItem: async (k) => {
      map.delete(k);
    },
  };
  return {
    storage,
    map,
    calls,
    holdNext: (op: 'get' | 'set' | null) => {
      hold = op;
    },
    failNext: (op: 'get' | 'set') => {
      failNext = op;
    },
  };
}

describe('answers blob: read and write through storage', () => {
  const KEY = `${BILL}.${HANA}.${AT_MS}`;
  const NOW = AT_MS + MIN;
  const BLOB_KEY = `splitit.sentcheck.v1.${SAM}`;

  it('writes one JSON blob per user under the blob key and reads it back', async () => {
    const s = fakeStorage();
    await expect(storeSentCheckAnswer(s.storage, SAM, KEY, 'yes', NOW)).resolves.toBe(true);
    expect([...s.map.keys()]).toEqual([BLOB_KEY]);
    expect(JSON.parse(s.map.get(BLOB_KEY) ?? '')).toEqual({ [KEY]: { a: 'yes', t: NOW } });
    await expect(readSentCheckBlob(s.storage, SAM)).resolves.toEqual({ [KEY]: { a: 'yes', t: NOW } });
  });

  it('keeps answers per user: another user on the device starts empty', async () => {
    const s = fakeStorage();
    await storeSentCheckAnswer(s.storage, SAM, KEY, 'undo', NOW);
    await expect(readSentCheckBlob(s.storage, HANA)).resolves.toEqual({});
  });

  it('two answers written at once both land (writes are serialised per user)', async () => {
    const s = fakeStorage();
    const k2 = `${BILL}.${DEE}.${AT_MS}`;
    const [a, b] = await Promise.all([
      storeSentCheckAnswer(s.storage, SAM, KEY, 'yes', NOW),
      storeSentCheckAnswer(s.storage, SAM, k2, 'shown', NOW),
    ]);
    expect([a, b]).toEqual([true, true]);
    const blob = await readSentCheckBlob(s.storage, SAM);
    expect(blob).toEqual({ [KEY]: { a: 'yes', t: NOW }, [k2]: { a: 'shown', t: NOW } });
  });

  it("'undo' then 'shown' at once still reads 'undo'", async () => {
    const s = fakeStorage();
    await Promise.all([
      storeSentCheckAnswer(s.storage, SAM, KEY, 'undo', NOW),
      storeSentCheckAnswer(s.storage, SAM, KEY, 'shown', NOW),
    ]);
    expect(answerFor(await readSentCheckBlob(s.storage, SAM), KEY)).toBe('undo');
  });

  it('a malformed stored blob reads as empty and is replaced on the next write', async () => {
    const s = fakeStorage();
    s.map.set(BLOB_KEY, '{oops');
    await expect(readSentCheckBlob(s.storage, SAM)).resolves.toEqual({});
    await storeSentCheckAnswer(s.storage, SAM, KEY, 'yes', NOW);
    expect(JSON.parse(s.map.get(BLOB_KEY) ?? '')).toEqual({ [KEY]: { a: 'yes', t: NOW } });
  });

  it('a read that throws reads as empty; a write that throws returns false', async () => {
    const s = fakeStorage();
    s.failNext('get');
    await expect(readSentCheckBlob(s.storage, SAM)).resolves.toEqual({});
    s.failNext('set');
    await expect(storeSentCheckAnswer(s.storage, SAM, KEY, 'yes', NOW)).resolves.toBe(false);
    // The queue isn't stuck after a failure.
    await expect(storeSentCheckAnswer(s.storage, SAM, KEY, 'yes', NOW)).resolves.toBe(true);
  });

  it('refuses a bad user id or entry key without touching storage', async () => {
    const s = fakeStorage();
    await expect(storeSentCheckAnswer(s.storage, 'sam:1', KEY, 'yes', NOW)).resolves.toBe(false);
    await expect(storeSentCheckAnswer(s.storage, SAM, 'bad:key', 'yes', NOW)).resolves.toBe(false);
    await expect(readSentCheckBlob(s.storage, 'not-a-uuid')).resolves.toEqual({});
    expect(s.calls).toEqual([]);
  });

  describe('a storage call that never settles', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('a read gives up after the time limit and reads as empty', async () => {
      const s = fakeStorage();
      s.holdNext('get');
      const p = readSentCheckBlob(s.storage, SAM);
      await jest.advanceTimersByTimeAsync(SENT_CHECK_STORAGE_TIMEOUT_MS);
      await expect(p).resolves.toEqual({});
      expect(jest.getTimerCount()).toBe(0);
    });

    it('a write gives up after the time limit, returns false, and the next write still runs', async () => {
      const s = fakeStorage();
      s.holdNext('set');
      const first = storeSentCheckAnswer(s.storage, SAM, KEY, 'yes', NOW);
      await jest.advanceTimersByTimeAsync(SENT_CHECK_STORAGE_TIMEOUT_MS);
      await expect(first).resolves.toBe(false);
      s.holdNext(null);
      const second = storeSentCheckAnswer(s.storage, SAM, KEY, 'undo', NOW);
      await jest.advanceTimersByTimeAsync(0);
      await expect(second).resolves.toBe(true);
      expect(answerFor(parseSentCheckBlob(s.map.get(BLOB_KEY)), KEY)).toBe('undo');
      expect(jest.getTimerCount()).toBe(0);
    });

    it("a write whose read never settles writes nothing, so other answers aren't lost", async () => {
      const s = fakeStorage();
      const other = `${BILL}.${DEE}.${AT_MS}`;
      s.map.set(BLOB_KEY, JSON.stringify({ [other]: { a: 'undo', t: NOW } }));
      s.holdNext('get');
      const p = storeSentCheckAnswer(s.storage, SAM, KEY, 'yes', NOW);
      await jest.advanceTimersByTimeAsync(SENT_CHECK_STORAGE_TIMEOUT_MS);
      await expect(p).resolves.toBe(false);
      expect(s.calls.filter((c) => c.startsWith('set'))).toEqual([]);
      expect(JSON.parse(s.map.get(BLOB_KEY) ?? '')).toEqual({ [other]: { a: 'undo', t: NOW } });
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe('sentCheckInline (criterion 25, C1–C7)', () => {
  const base = { billId: BILL, payerId: HANA, mark: venmoMark(), hasDifference: false };
  const KEY = `${BILL}.${HANA}.${AT_MS}`;
  const NOW = AT_MS + 2 * MIN;

  it('C1: shows for an unanswered venmo mark within 30 minutes, with the key and the facts the undo rule needs', () => {
    expect(sentCheckInline(base, {}, NOW)).toEqual({ key: KEY, billId: BILL, payerId: HANA, cents: 1510, markAtMs: AT_MS });
  });

  it.each<['yes' | 'undo' | 'shown']>([['yes'], ['undo'], ['shown']])("C2: not after '%s'", (answer) => {
    expect(sentCheckInline(base, withAnswer({}, KEY, answer, NOW), NOW)).toBeNull();
  });

  it("C7: not for a mark whose key contract O's Yes, I sent it stored as 'yes'", () => {
    const store = withAnswer({}, KEY, 'yes', AT_MS); // stored the moment he answered
    expect(sentCheckInline(base, store, NOW)).toBeNull();
  });

  it.each<['cash' | 'other']>([['cash'], ['other']])('C3: never for a %s mark', (method) => {
    expect(sentCheckInline({ ...base, mark: venmoMark({ method }) }, {}, NOW)).toBeNull();
  });

  it('C4: shows again for a new markAt (undo then send again), even when the old one was answered', () => {
    const store = withAnswer({}, KEY, 'undo', NOW);
    const resent = venmoMark({ at: '2026-11-26T19:50:00.000Z' });
    const out = sentCheckInline({ ...base, mark: resent }, store, Date.parse(resent.at) + MIN);
    expect(out?.key).toBe(`${BILL}.${HANA}.${Date.parse(resent.at)}`);
  });

  it('C5: exactly 30 minutes shows; 30 minutes + 1 ms does not', () => {
    expect(sentCheckInline(base, {}, AT_MS + 30 * MIN)).not.toBeNull();
    expect(sentCheckInline(base, {}, AT_MS + 30 * MIN + 1)).toBeNull();
  });

  it('a mark slightly in the future (clock skew) still shows', () => {
    expect(sentCheckInline(base, {}, AT_MS - 5000)).not.toBeNull();
  });

  it("C6 (A1): not when the mark's toUserId isn't the plan's payer", () => {
    expect(sentCheckInline({ ...base, mark: venmoMark({ toUserId: DEE }) }, {}, NOW)).toBeNull();
    expect(sentCheckInline({ ...base, payerId: DEE }, {}, NOW)).toBeNull();
  });

  it('a different payer in the key is a different key: an answer for Hana does not hide a check for Dee', () => {
    const store = withAnswer({}, KEY, 'yes', NOW);
    const out = sentCheckInline({ ...base, payerId: DEE, mark: venmoMark({ toUserId: DEE }) }, store, NOW);
    expect(out?.key).toBe(`${BILL}.${DEE}.${AT_MS}`);
  });

  it('no mark → null', () => {
    expect(sentCheckInline({ ...base, mark: null }, {}, NOW)).toBeNull();
  });

  it('F4: not for "more" sends, and not while a difference is due (the card is the difference card)', () => {
    expect(sentCheckInline({ ...base, lastSend: 'more' }, {}, NOW)).toBeNull();
    expect(sentCheckInline({ ...base, hasDifference: true }, {}, NOW)).toBeNull();
    expect(sentCheckInline({ ...base, lastSend: 'share' }, {}, NOW)).not.toBeNull();
  });

  it('an unparseable mark time or bad ids → null (no key can be built)', () => {
    expect(sentCheckInline({ ...base, mark: venmoMark({ at: 'garbage' }) }, {}, NOW)).toBeNull();
    expect(sentCheckInline({ ...base, billId: 'x:y' }, {}, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe('undoDecision (criterion 27, A1 F6)', () => {
  const data = { cents: 1510, markAtMs: AT_MS, payerId: HANA };

  it("row 1: stored 'undo' → noop, whatever the mark is", () => {
    expect(undoDecision('undo', venmoMark(), data)).toBe('noop');
    expect(undoDecision('undo', null, data)).toBe('noop');
    expect(undoDecision('undo', venmoMark({ cents: 999 }), data)).toBe('noop');
  });

  it("row 2: the fresh mark is gone → silent (store 'undo', cancel, show nothing)", () => {
    expect(undoDecision(null, null, data)).toBe('silent');
    expect(undoDecision('yes', null, data)).toBe('silent');
    expect(undoDecision('shown', null, data)).toBe('silent');
  });

  it('row 3: the fresh mark matches on method, cents, markAtMs and toUserId → unmark', () => {
    expect(undoDecision(null, venmoMark(), data)).toBe('unmark');
    expect(undoDecision('yes', venmoMark(), data)).toBe('unmark'); // a later "No, undo" still wins over a Yes
    expect(undoDecision('shown', venmoMark(), data)).toBe('unmark');
    // The DB's spelling of the same instant matches (compared as numbers).
    expect(undoDecision(null, venmoMark({ at: '2026-11-26T19:42:00.123+00:00' }), data)).toBe('unmark');
  });

  it.each<[string, Partial<SentCheckMark>]>([
    ['the method', { method: 'cash' }],
    ['the cents', { cents: 1620 }],
    ['markAtMs', { at: '2026-11-26T19:42:00.124Z' }],
    ['toUserId', { toUserId: DEE }],
  ])('row 4: changed when only %s differs', (_label, over) => {
    expect(undoDecision(null, venmoMark(over), data)).toBe('changed');
  });

  it('an unparseable fresh mark time is "changed", never "unmark"', () => {
    expect(undoDecision(null, venmoMark({ at: 'garbage' }), data)).toBe('changed');
  });
});

// ---------------------------------------------------------------------------------------------
describe('sentCheckNotification (criterion 26)', () => {
  const input = { payerName: 'Hana', cents: 1510, billId: BILL, userId: SAM, payerId: HANA, markAtMs: AT_MS };

  it('title SplitIt, the body, no sound, no badge, a 60 s one-shot trigger, the id and the category', () => {
    const n = sentCheckNotification(input);
    expect(n).not.toBeNull();
    expect(n?.identifier).toBe(`sentcheck.${SAM}.${BILL}.${HANA}.${AT_MS}`);
    expect(n?.content.title).toBe('SplitIt');
    expect(n?.content.body).toBe('Did your $15.10 to Hana go through?');
    expect(n?.content.sound).toBe(false);
    expect(n?.content).not.toHaveProperty('badge');
    expect(n?.content.categoryIdentifier).toBe(SENT_CHECK_CATEGORY_ID);
    expect(n?.trigger).toEqual({ seconds: 60, repeats: false });
  });

  it('data holds exactly billId, userId, payerId, cents, markAtMs (no names, no bill name, no handles)', () => {
    const n = sentCheckNotification(input);
    expect(Object.keys(n?.content.data ?? {}).sort()).toEqual(['billId', 'cents', 'markAtMs', 'payerId', 'userId']);
    expect(n?.content.data).toEqual({ billId: BILL, userId: SAM, payerId: HANA, cents: 1510, markAtMs: AT_MS });
    expect(JSON.stringify(n?.content.data)).not.toContain('Hana');
  });

  it('a blank name reads "Did your $15.10 go through?"; 1 cent reads $0.01', () => {
    expect(sentCheckNotification({ ...input, payerName: '   ' })?.content.body).toBe('Did your $15.10 go through?');
    expect(sentCheckNotification({ ...input, payerName: '' })?.content.body).toBe('Did your $15.10 go through?');
    expect(sentCheckNotification({ ...input, cents: 1 })?.content.body).toBe('Did your $0.01 to Hana go through?');
  });

  it('cleans the name before it leaves the app: control and format characters removed, whitespace collapsed, capped', () => {
    expect(sentCheckNotification({ ...input, payerName: ' Ha\u0000na‮ \n Lee ' })?.content.body).toBe(
      'Did your $15.10 to Hana Lee go through?',
    );
    expect(sentCheckNotification({ ...input, payerName: '​\u0007' })?.content.body).toBe('Did your $15.10 go through?');
    const long = sentCheckNotification({ ...input, payerName: '😀'.repeat(60) })?.content.body ?? '';
    expect(Array.from(long.replace('Did your $15.10 to ', '').replace(' go through?', '')).length).toBeLessThanOrEqual(40);
    expect(long).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/); // no half emoji
  });

  it('returns null when the facts are not valid (no notification rather than a wrong one)', () => {
    expect(sentCheckNotification({ ...input, cents: 0 })).toBeNull();
    expect(sentCheckNotification({ ...input, cents: 15.1 })).toBeNull();
    expect(sentCheckNotification({ ...input, billId: 'x' })).toBeNull();
    expect(sentCheckNotification({ ...input, markAtMs: Number.NaN })).toBeNull();
  });

  it('category: Yes stays in the background; No, undo opens the app and is destructive; hidden-preview text', () => {
    expect(SENT_CHECK_CATEGORY_ID).toBe('sent_check');
    expect(SENT_CHECK_ACTIONS).toEqual([
      { identifier: 'yes', buttonTitle: 'Yes', options: { opensAppToForeground: false } },
      { identifier: 'undo', buttonTitle: 'No, undo', options: { opensAppToForeground: true, isDestructive: true } },
    ]);
    expect(SENT_CHECK_PREVIEW_PLACEHOLDER).toBe('Check your SplitIt payment');
  });
});

// ---------------------------------------------------------------------------------------------
describe('parseSentCheckData (criterion 52)', () => {
  const good = { billId: BILL, userId: SAM, payerId: HANA, cents: 1510, markAtMs: AT_MS };

  it('accepts the exact shape for the signed-in user', () => {
    expect(parseSentCheckData(good, SAM)).toEqual(good);
  });

  it.each<[string, unknown]>([
    ['a non-UUID billId', { ...good, billId: 'bill-1' }],
    ['a non-UUID userId', { ...good, userId: 7 }],
    ['a non-UUID payerId', { ...good, payerId: `${HANA}:x` }],
    ['non-integer cents', { ...good, cents: 15.1 }],
    ['string cents', { ...good, cents: '1510' }],
    ['zero cents', { ...good, cents: 0 }],
    ['a string markAtMs', { ...good, markAtMs: String(AT_MS) }],
    ['a NaN markAtMs', { ...good, markAtMs: Number.NaN }],
    ['a fractional markAtMs', { ...good, markAtMs: 1.5 }],
    ['an extra key carrying a URL', { ...good, url: 'https://evil.example/x' }],
    ['an extra route key', { ...good, route: '/profile' }],
    ['a missing key', { billId: BILL, userId: SAM, payerId: HANA, cents: 1510 }],
    ['an array', [BILL, SAM, HANA, 1510, AT_MS]],
    ['null', null],
    ['a string', JSON.stringify(good)],
  ])('rejects %s', (_label, raw) => {
    expect(parseSentCheckData(raw, SAM)).toBeNull();
  });

  it("rejects a userId other than the session's, and anything while signed out", () => {
    expect(parseSentCheckData(good, HANA)).toBeNull();
    expect(parseSentCheckData(good, null)).toBeNull();
    expect(parseSentCheckData(good, '')).toBeNull();
  });

  it('round-trips what sentCheckNotification puts in data', () => {
    const n = sentCheckNotification({ payerName: 'Hana', ...good });
    expect(parseSentCheckData(n?.content.data, SAM)).toEqual(good);
  });
});

const uuidRand = mulberry32(2026);
/** A random-looking v4 UUID from a seeded PRNG (repeatable; no Node `crypto` types in this project). */
function randomUUID(): string {
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(uuidRand() * 16).toString(16)).join('');
  const variant = '89ab'[Math.floor(uuidRand() * 4)] ?? '8';
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

/** Small seeded PRNG so the fuzz test is repeatable. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('sentCheckInlineEndsInMs (review R10): when the inline question has to go', () => {
  const WINDOW = SENT_CHECK_INLINE_MAX_MINUTES * MIN;
  it('the ms until 30 min + 1 ms after the mark', () => {
    expect(sentCheckInlineEndsInMs(AT, AT_MS)).toBe(WINDOW + 1);
    expect(sentCheckInlineEndsInMs(AT, AT_MS + WINDOW - 5)).toBe(6);
  });
  it('exactly 30 min still shows (1 ms to go); past it, null', () => {
    expect(sentCheckInlineEndsInMs(AT, AT_MS + WINDOW)).toBe(1);
    expect(sentCheckInlineEndsInMs(AT, AT_MS + WINDOW + 1)).toBeNull();
  });
  it('agrees with sentCheckInline at the boundary', () => {
    const input = { billId: BILL, payerId: HANA, mark: venmoMark(), hasDifference: false };
    expect(sentCheckInline(input, {}, AT_MS + WINDOW)).not.toBeNull();
    expect(sentCheckInline(input, {}, AT_MS + WINDOW + 1)).toBeNull();
  });
  it('no mark or an unreadable time → null', () => {
    expect(sentCheckInlineEndsInMs(null, AT_MS)).toBeNull();
    expect(sentCheckInlineEndsInMs('not a time', AT_MS)).toBeNull();
  });
});

describe('isLateOwnSend (review R4): a mark that may have landed for a Venmo that never opened', () => {
  const sent = { cents: 1510, payerId: HANA, tapAtMs: AT_MS };
  it('the venmo mark for this amount and payer, made at or after the tap', () => {
    expect(isLateOwnSend(venmoMark(), sent)).toBe(true);
    expect(isLateOwnSend(venmoMark({ at: new Date(AT_MS + 3000).toISOString() }), sent)).toBe(true);
  });
  it('allows the server clock to be a little behind the phone', () => {
    expect(isLateOwnSend(venmoMark(), { ...sent, tapAtMs: AT_MS + LATE_SEND_SKEW_MS })).toBe(true);
    expect(isLateOwnSend(venmoMark(), { ...sent, tapAtMs: AT_MS + LATE_SEND_SKEW_MS + 1 })).toBe(false);
  });
  it('anything else is not ours: no mark, cash, another amount or payer', () => {
    expect(isLateOwnSend(null, sent)).toBe(false);
    expect(isLateOwnSend(venmoMark({ method: 'cash' }), sent)).toBe(false);
    expect(isLateOwnSend(venmoMark({ cents: 1400 }), sent)).toBe(false);
    expect(isLateOwnSend(venmoMark({ toUserId: DEE }), sent)).toBe(false);
    expect(isLateOwnSend(venmoMark({ at: 'garbage' }), sent)).toBe(false);
  });
});
