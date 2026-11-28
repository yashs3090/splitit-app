// Contract H (docs/specs/2026-11-28-tab-bar-and-activity.md), criterion 22: the share a feed line
// shows. Expected cents are worked out by hand from the bill below, then cross-checked against the
// bill screen's own path (displayShares(splitInputFor(...))) so the two can't drift.
import type { BillData } from './bills';
import { splitInputFor } from './billView';
import { feedShareCents } from './feedShare';
import { displayShares } from './split';

const ME = '0e000000-0000-4000-8000-000000000001';
const MAYA = '0a000000-0000-4000-8000-000000000002';
const SAM = '05000000-0000-4000-8000-000000000003';
const TACOS = '10000000-0000-4000-8000-000000000001';
const FRIES = '10000000-0000-4000-8000-000000000002';
const SODA = '10000000-0000-4000-8000-000000000003';
const COUPON = '10000000-0000-4000-8000-000000000004';

type Row = BillData['rows'][number];
const row = (id: string, name: string, cents: number, kind: 'item' | 'discount' = 'item'): Row => ({
  id,
  name,
  note: null,
  group_position: 0,
  unit_index: 0,
  group_size: 1,
  total_cents: cents,
  kind,
  applies_to: kind === 'discount' ? 'total' : null,
  split_set_by: null,
  split_set_at: null,
});
const member = (userId: string, displayName: string) => ({ userId, displayName, venmoUsername: null, mark: null, notReceived: null });

/**
 * Maya's bill: Tacos $10.00 (me), Fries $10.00 (Sam), Soda $4.00 (Sam unless `sodaUnclaimed`);
 * total $28.80, so extras are $4.80.
 */
function billData(over: { mode?: 'proportional' | 'equal'; sodaUnclaimed?: boolean; claims?: BillData['claims']; rows?: Row[]; total?: number } = {}): BillData {
  return {
    bill: {
      id: 'b1000000-0000-4000-8000-0000000000b1',
      host_id: MAYA,
      payer_id: MAYA,
      join_code: '0123456789abcdef0123',
      created_at: '2026-11-27T19:00:00.000Z',
      edited_at: null,
      extras_split: over.mode ?? 'proportional',
      subtotal_cents: 2400,
      tax_cents: 480,
      fees_cents: 0,
      tip_cents: 0,
      subtotal_discount_cents: 0,
      total_discount_cents: 0,
      total_cents: over.total ?? 2880,
    },
    rows: over.rows ?? [row(TACOS, 'Tacos', 1000), row(FRIES, 'Fries', 1000), row(SODA, 'Soda', 400)],
    participants: [member(MAYA, 'Maya'), member(ME, 'Me'), member(SAM, 'Sam')],
    claims: over.claims ?? [
      { line_item_id: TACOS, user_id: ME, parts: 1 },
      { line_item_id: FRIES, user_id: SAM, parts: 1 },
      ...(over.sodaUnclaimed ? [] : [{ line_item_id: SODA, user_id: SAM, parts: 1 }]),
    ],
    payers: [],
    payments: [],
    flags: [],
  };
}

/** The bill screen's figure for `userId` (app/(app)/bills/[id]/index.tsx runs exactly this). */
function screenShare(data: BillData, userId: string): number | null {
  return displayShares(splitInputFor(data, data.claims)).people.find((p) => p.userId === userId)?.totalCents ?? null;
}

describe('feedShareCents (Contract H)', () => {
  it('proportional: my current share, the same figure as the bill screen', () => {
    const data = billData();
    // By hand: my items 1000 of 2400 → extras 480 × 1000/2400 = 200 → 1200.
    expect(feedShareCents(data, ME)).toBe(1200);
    expect(feedShareCents(data, ME)).toBe(screenShare(data, ME));
    // Sam: 1400 + 280 = 1680.
    expect(feedShareCents(data, SAM)).toBe(1680);
    expect(feedShareCents(data, SAM)).toBe(screenShare(data, SAM));
  });

  it('proportional with an unclaimed item still has a share (only even mode waits)', () => {
    const data = billData({ sodaUnclaimed: true });
    // Weights: me 1000, Sam 1000, unclaimed 400 → extras 480: 200 / 200 / 80. Mine 1200.
    expect(feedShareCents(data, ME)).toBe(1200);
    expect(feedShareCents(data, ME)).toBe(screenShare(data, ME));
  });

  it('even mode: no share until every item is claimed', () => {
    const open = billData({ mode: 'equal', sodaUnclaimed: true });
    expect(screenShare(open, ME)).toBeNull(); // the bill screen hides it too
    expect(feedShareCents(open, ME)).toBeNull();

    const done = billData({ mode: 'equal' });
    // Everything claimed: extras 480 between me and Sam → 240 each. Mine 1000 + 240.
    expect(feedShareCents(done, ME)).toBe(1240);
    expect(feedShareCents(done, ME)).toBe(screenShare(done, ME));
  });

  it('null when I have no share: not on the bill, or nothing claimed', () => {
    const data = billData();
    expect(feedShareCents(data, '0f000000-0000-4000-8000-00000000000f')).toBeNull();
    // Maya is on the bill but claims nothing.
    expect(screenShare(data, MAYA)).toBe(0);
    expect(feedShareCents(data, MAYA)).toBeNull();
  });

  it('null when the bill data did not load', () => {
    expect(feedShareCents(null, ME)).toBeNull();
    expect(feedShareCents(undefined, ME)).toBeNull();
  });

  it('null for a negative share (a claimed discount bigger than my items) and for data split math refuses', () => {
    const rows = [row(TACOS, 'Tacos', 1000), row(FRIES, 'Fries', 1000), row(COUPON, 'Coupon', -1500, 'discount')];
    const claims = [
      { line_item_id: TACOS, user_id: SAM, parts: 1 },
      { line_item_id: FRIES, user_id: ME, parts: 1 },
      { line_item_id: COUPON, user_id: ME, parts: 1 },
    ];
    const negative = billData({ rows, claims, total: 500 });
    expect(screenShare(negative, ME)).toBeLessThan(0);
    expect(feedShareCents(negative, ME)).toBeNull();

    const broken = billData({ total: 28.8 });
    expect(feedShareCents(broken, ME)).toBeNull();
  });
});
