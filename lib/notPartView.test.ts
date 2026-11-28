// The bill screen's "I wasn't part of this" rules (spec docs/specs/2026-11-27-group-claim-status.md
// T6, C5, criteria 30, 32 and 34). Expected values worked out by hand from the spec's visibility rules.
import { hasClaimOn, nextNotPartError, notPartView, type NotPartRead } from './notPartView';

const ME = 'me';
const ANA = 'ana';
const ready = (notPart: boolean): NotPartRead => ({ status: 'ready', notPart });

describe('notPartView', () => {
  const someUnclaimed = [{ claimerIds: [ANA] }, { claimerIds: [] }];
  const fullyClaimed = [{ claimerIds: [ANA] }, { claimerIds: [ANA] }];
  const mineAndUnclaimed = [{ claimerIds: [ME] }, { claimerIds: [] }];

  it('a bill in no group: no tint and no line, whatever the read says', () => {
    for (const read of [{ status: 'loading' } as const, { status: 'failed' } as const, ready(false), ready(true)]) {
      expect(notPartView({ inGroup: false, read, serverRows: someUnclaimed, viewerId: ME })).toEqual({ tintUnclaimed: false, line: null });
    }
  });

  it('criterion 34: while the read is loading, no tint and no line (no flash)', () => {
    expect(notPartView({ inGroup: true, read: { status: 'loading' }, serverRows: someUnclaimed, viewerId: ME })).toEqual({
      tintUnclaimed: false,
      line: null,
    });
  });

  it('criterion 34: a failed read tints (fail toward reminding) and hides the line', () => {
    expect(notPartView({ inGroup: true, read: { status: 'failed' }, serverRows: someUnclaimed, viewerId: ME })).toEqual({
      tintUnclaimed: true,
      line: null,
    });
  });

  it('criterion 32: unclaimed rows and no claim of mine: tint, and the prompt', () => {
    expect(notPartView({ inGroup: true, read: ready(false), serverRows: someUnclaimed, viewerId: ME })).toEqual({
      tintUnclaimed: true,
      line: 'prompt',
    });
  });

  it('criterion 32: opted out: no tint, and the "done" line with Undo', () => {
    expect(notPartView({ inGroup: true, read: ready(true), serverRows: someUnclaimed, viewerId: ME })).toEqual({
      tintUnclaimed: false,
      line: 'done',
    });
  });

  it('criterion 32: a server claim of mine hides the line; unclaimed rows stay tinted', () => {
    expect(notPartView({ inGroup: true, read: ready(false), serverRows: mineAndUnclaimed, viewerId: ME })).toEqual({
      tintUnclaimed: true,
      line: null,
    });
  });

  it('claims win over a stale opt-out (B4): tint is back and no line', () => {
    expect(notPartView({ inGroup: true, read: ready(true), serverRows: mineAndUnclaimed, viewerId: ME })).toEqual({
      tintUnclaimed: true,
      line: null,
    });
  });

  it('criterion 32: a fully claimed bill with no opt-out shows no line', () => {
    expect(notPartView({ inGroup: true, read: ready(false), serverRows: fullyClaimed, viewerId: ME }).line).toBeNull();
  });

  it('a bill with no rows needs nobody: no line', () => {
    expect(notPartView({ inGroup: true, read: ready(false), serverRows: [], viewerId: ME }).line).toBeNull();
  });

  it('a split row I share counts as my claim (B8)', () => {
    const rows = [{ claimerIds: [ANA, ME] }, { claimerIds: [] }];
    expect(notPartView({ inGroup: true, read: ready(false), serverRows: rows, viewerId: ME }).line).toBeNull();
  });
});

describe('hasClaimOn', () => {
  it('is true only when one of the rows names the viewer', () => {
    expect(hasClaimOn([{ claimerIds: [ANA] }, { claimerIds: [] }], ME)).toBe(false);
    expect(hasClaimOn([{ claimerIds: [ANA, ME] }], ME)).toBe(true);
    expect(hasClaimOn([], ME)).toBe(false);
  });
});

describe('nextNotPartError (review R1: an error lasts only while the line it was raised under does)', () => {
  const hasClaims = { error: 'has_claims' as const, under: 'prompt' as const };
  const network = { error: 'network' as const, under: 'prompt' as const };

  it('no error stays none; the same line keeps it', () => {
    expect(nextNotPartError(null, 'prompt')).toBeNull();
    expect(nextNotPartError(network, 'prompt')).toBe(network);
  });

  it('has_claims follows its own outcome once (the refetch shows my claim: no line), and keeps its words', () => {
    expect(nextNotPartError(hasClaims, null)).toEqual({ error: 'has_claims', under: null });
  });

  it('has_claims, then unclaiming (the prompt is back): the words are no longer true, so they go', () => {
    const followed = nextNotPartError(hasClaims, null);
    expect(nextNotPartError(followed, 'prompt')).toBeNull();
  });

  it('network, then claiming (no line any more): nothing left to retry, so it goes', () => {
    expect(nextNotPartError(network, null)).toBeNull();
  });

  it('any other change of line clears it', () => {
    expect(nextNotPartError(network, 'done')).toBeNull();
    expect(nextNotPartError({ error: 'not_allowed', under: 'done' }, 'prompt')).toBeNull();
  });
});
