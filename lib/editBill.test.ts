// Host edit screen copy and claim counts: Task 13 of docs/specs/2026-11-20-m1b-m2-share-and-claim.md
// (criteria 101–102, A3.4).
import type { BillDraft } from './billDraft';
import { draftFromSaved, type SavedClaim } from './billPayload';
import { claimerCount, deleteConfirmCopy, freshSaveCheck, saveConfirmCopy, type EditRow } from './editBill';

const claim = (line_item_id: string, user_id: string) => ({ line_item_id, user_id, parts: 1 });

const ROWS: EditRow[] = [
  { id: 'burger', name: 'Burger', group_position: 0 },
  { id: 'fries', name: 'Fries', group_position: 1 },
  { id: 'beer1', name: 'Beer', group_position: 2 },
  { id: 'beer2', name: 'Beer', group_position: 2 },
  { id: 'wing1', name: 'Wings', group_position: 3 },
  { id: 'wing2', name: 'Wings', group_position: 3 },
  { id: 'wing3', name: 'Wings', group_position: 3 },
];

describe('claimerCount', () => {
  it('counts distinct people across a group\'s units', () => {
    const claims = [claim('beer1', 'a'), claim('beer2', 'a'), claim('beer2', 'b'), claim('fries', 'c')];
    expect(claimerCount(['beer1', 'beer2'], claims)).toBe(2);
    expect(claimerCount(['fries'], claims)).toBe(1);
    expect(claimerCount(['burger'], claims)).toBe(0);
    expect(claimerCount([], claims)).toBe(0);
  });
});

describe('deleteConfirmCopy', () => {
  it('reads "<N> people claimed this. Delete it anyway?"', () => {
    expect(deleteConfirmCopy(2)).toBe('2 people claimed this. Delete it anyway?');
    expect(deleteConfirmCopy(3)).toBe('3 people claimed this. Delete it anyway?');
  });
  it('uses "person" for one', () => {
    expect(deleteConfirmCopy(1)).toBe('1 person claimed this. Delete it anyway?');
  });
});

describe('saveConfirmCopy', () => {
  const none = { droppedClaimedIds: [], removedClaimedIds: [] };

  it('is null when nothing claimed is lost', () => {
    expect(saveConfirmCopy(none, ROWS, [])).toBeNull();
  });

  it('102: lowering a quantity names the claimed units removed', () => {
    expect(saveConfirmCopy({ ...none, droppedClaimedIds: ['beer2'] }, ROWS, [])).toBe(
      'Lowering the quantity removes 1 claimed Beer. Continue?',
    );
  });

  it('lists several items, in bill order, with a count each', () => {
    expect(saveConfirmCopy({ ...none, droppedClaimedIds: ['wing3', 'wing2', 'beer2'] }, ROWS, [])).toBe(
      'Lowering the quantity removes 1 claimed Beer and 2 claimed Wings. Continue?',
    );
  });

  it('A3.4: a cleared saved row names the item and how many people claimed it', () => {
    const claims = [claim('fries', 'a'), claim('fries', 'b')];
    expect(saveConfirmCopy({ ...none, removedClaimedIds: ['fries'] }, ROWS, claims)).toBe(
      'Saving deletes Fries, which 2 people claimed. Continue?',
    );
    expect(saveConfirmCopy({ ...none, removedClaimedIds: ['beer1'] }, ROWS, [claim('beer1', 'a')])).toBe(
      'Saving deletes Beer, which 1 person claimed. Continue?',
    );
  });

  it('combines both kinds into one question', () => {
    const claims = [claim('fries', 'a'), claim('beer2', 'b')];
    expect(saveConfirmCopy({ droppedClaimedIds: ['beer2'], removedClaimedIds: ['fries'] }, ROWS, claims)).toBe(
      'Lowering the quantity removes 1 claimed Beer. Saving deletes Fries, which 1 person claimed. Continue?',
    );
  });

  it('ignores ids it does not know, and returns null if none are left', () => {
    expect(saveConfirmCopy({ droppedClaimedIds: ['nope'], removedClaimedIds: ['gone'] }, ROWS, [])).toBeNull();
  });
});

describe('freshSaveCheck (R1: re-check claims at save time)', () => {
  const bill = {
    subtotal_cents: null,
    tax_cents: 0,
    fees_cents: 0,
    tip_cents: 0,
    subtotal_discount_cents: 0,
    total_discount_cents: 0,
    total_cents: 2900,
    edited_at: null as string | null,
  };
  const unit = (id: string, name: string, cents: number, g: number, u = 0, size = 1) => ({
    id,
    name,
    note: null,
    group_position: g,
    unit_index: u,
    group_size: size,
    total_cents: cents,
  });
  const rows = [unit('burger', 'Burger', 1500, 0), unit('beer1', 'Beer', 700, 1, 0, 2), unit('beer2', 'Beer', 700, 1, 1, 2)];

  /** Opens the form on `claims`, lowers Beer to 1 (price 7.00, total 22.00), returns what onSave has. */
  function lowerBeer(claimsAtOpen: SavedClaim[]) {
    const snapshot = { bill, rows, claims: claimsAtOpen };
    const { draft, saved } = draftFromSaved(bill, rows, claimsAtOpen);
    const beer = draft.items[1]!;
    const edited: BillDraft = {
      ...draft,
      items: draft.items.map((i) => (i.id === beer.id ? { ...i, qty: '1', price: '7.00' } : i)),
      totals: { ...draft.totals, total: '22.00' },
    };
    return { snapshot, saved, draft: edited };
  }
  const keptIds = (r: ReturnType<typeof freshSaveCheck>) => (r.kind === 'ready' ? r.args.rows.map((x) => x.id) : null);

  it('Pat claimed Beer 2 after Edit opened: the unclaimed Beer 1 is dropped instead, with no question', () => {
    const { snapshot, saved, draft } = lowerBeer([]);
    // The stale snapshot would drop beer2 (highest index, unclaimed then).
    const r = freshSaveCheck(draft, snapshot, saved, { bill, rows, claims: [claim('beer2', 'pat')] });
    expect(r.kind).toBe('ready');
    expect(keptIds(r)).toEqual(['burger', 'beer2']);
    expect(r.kind === 'ready' && r.question).toBeNull();
  });

  it('Pat claimed Beer 2 after Edit opened, Beer 1 was already claimed: the question appears', () => {
    const { snapshot, saved, draft } = lowerBeer([claim('beer1', 'bo')]);
    const stale = freshSaveCheck(draft, snapshot, saved, snapshot);
    expect(stale.kind === 'ready' && stale.question).toBeNull(); // with the opening claims, nothing to ask
    const r = freshSaveCheck(draft, snapshot, saved, { bill, rows, claims: [claim('beer1', 'bo'), claim('beer2', 'pat')] });
    expect(r.kind === 'ready' && r.question).toBe('Lowering the quantity removes 1 claimed Beer. Continue?');
    expect(keptIds(r)).toEqual(['burger', 'beer1']);
  });

  it('asks about a deleted row someone claimed after the host deleted it without a question', () => {
    const snapshot = { bill, rows, claims: [] as SavedClaim[] };
    const { draft, saved } = draftFromSaved(bill, rows, []);
    const edited: BillDraft = { ...draft, items: draft.items.slice(1), totals: { ...draft.totals, total: '14.00' } };
    const r = freshSaveCheck(edited, snapshot, saved, { bill, rows, claims: [claim('burger', 'pat')] });
    expect(r.kind === 'ready' && r.question).toBe('Saving deletes Burger, which 1 person claimed. Continue?');
  });

  it('does not ask again about a deleted row the host already confirmed', () => {
    const claims = [claim('burger', 'pat')];
    const snapshot = { bill, rows, claims };
    const { draft, saved } = draftFromSaved(bill, rows, claims);
    const edited: BillDraft = { ...draft, items: draft.items.slice(1), totals: { ...draft.totals, total: '14.00' } };
    const r = freshSaveCheck(edited, snapshot, saved, { bill, rows, claims: [...claims, claim('burger', 'sam')] });
    expect(r.kind === 'ready' && r.question).toBeNull();
  });

  it('reports "changed" when edited_at or the row ids differ from the snapshot', () => {
    const { snapshot, saved, draft } = lowerBeer([]);
    expect(freshSaveCheck(draft, snapshot, saved, { ...snapshot, bill: { ...bill, edited_at: '2026-11-21T10:00:00Z' } }).kind).toBe(
      'changed',
    );
    expect(freshSaveCheck(draft, snapshot, saved, { ...snapshot, rows: rows.slice(0, 2) }).kind).toBe('changed');
    expect(freshSaveCheck(draft, snapshot, saved, { ...snapshot, rows: [...rows.slice(0, 2), unit('beer9', 'Beer', 700, 1, 1, 2)] }).kind).toBe(
      'changed',
    );
  });
});

// Claimable discounts: docs/specs/2026-11-24-claimable-discounts.md (criteria 32, 33).
describe('claimable discounts on the edit screen', () => {
  const COMP_ROWS: EditRow[] = [...ROWS, { id: 'comp', name: 'Police comp', group_position: 4 }, { id: 'coupon', name: 'Coupon', group_position: 5 }];
  const none = { droppedClaimedIds: [], removedClaimedIds: [], splitClaimedIds: [] };

  it('32: Claim → Split reads "Sharing <name> with everyone removes N person\'s/people\'s claim(s)."', () => {
    expect(saveConfirmCopy({ ...none, splitClaimedIds: ['comp'] }, COMP_ROWS, [claim('comp', 'a')])).toBe(
      "Sharing Police comp with everyone removes 1 person's claim. Continue?",
    );
    expect(saveConfirmCopy({ ...none, splitClaimedIds: ['comp'] }, COMP_ROWS, [claim('comp', 'a'), claim('comp', 'b')])).toBe(
      "Sharing Police comp with everyone removes 2 people's claims. Continue?",
    );
  });

  it('32: one sentence per discount, after the other kinds', () => {
    const claims = [claim('comp', 'a'), claim('coupon', 'b'), claim('fries', 'c')];
    expect(
      saveConfirmCopy({ droppedClaimedIds: [], removedClaimedIds: ['fries'], splitClaimedIds: ['coupon', 'comp'] }, COMP_ROWS, claims),
    ).toBe(
      "Saving deletes Fries, which 1 person claimed. Sharing Police comp with everyone removes 1 person's claim. " +
        "Sharing Coupon with everyone removes 1 person's claim. Continue?",
    );
  });

  it('32: the existing copy is unchanged without splitClaimedIds, and unknown ids are ignored', () => {
    expect(saveConfirmCopy({ droppedClaimedIds: ['beer2'], removedClaimedIds: [] }, ROWS, [])).toBe(
      'Lowering the quantity removes 1 claimed Beer. Continue?',
    );
    expect(saveConfirmCopy({ ...none, splitClaimedIds: ['gone'] }, COMP_ROWS, [])).toBeNull();
  });

  describe('33: freshSaveCheck', () => {
    // Steak 16.03, Salad 14.00, claimable comp -16.03 (subtotal), subtotal 14.00, tax 2.40, total 16.40.
    const bill = {
      subtotal_cents: 1400,
      tax_cents: 240,
      fees_cents: 0,
      tip_cents: 0,
      subtotal_discount_cents: 0,
      total_discount_cents: 0,
      total_cents: 1640,
      edited_at: null as string | null,
    };
    const rows = [
      { id: 'steak', name: 'Steak', note: null, group_position: 0, unit_index: 0, group_size: 1, total_cents: 1603, kind: 'item' as const, applies_to: null },
      { id: 'salad', name: 'Salad', note: null, group_position: 1, unit_index: 0, group_size: 1, total_cents: 1400, kind: 'item' as const, applies_to: null },
      { id: 'comp', name: 'Police comp', note: null, group_position: 2, unit_index: 0, group_size: 1, total_cents: -1603, kind: 'discount' as const, applies_to: 'subtotal' as const },
    ];

    it("doesn't report a kept claimable discount as deleted", () => {
      const claims = [claim('comp', 'pat')];
      const snapshot = { bill, rows, claims: [] as SavedClaim[] };
      const { draft, saved } = draftFromSaved(bill, rows, []);
      const r = freshSaveCheck(draft, snapshot, saved, { bill, rows, claims });
      expect(r.kind).toBe('ready');
      expect(r.kind === 'ready' && r.question).toBeNull();
      expect(r.kind === 'ready' && r.args.rows.map((x) => x.id)).toEqual(['steak', 'salad', 'comp']);
    });

    it('asks about a discount someone claimed after the form opened that the save switches to Split', () => {
      const snapshot = { bill, rows, claims: [] as SavedClaim[] };
      const { draft, saved } = draftFromSaved(bill, rows, []);
      const compId = draft.discounts[0]!.id;
      const edited: BillDraft = { ...draft, discounts: draft.discounts.map((x) => (x.id === compId ? { ...x, claimable: false } : x)) };
      const stale = freshSaveCheck(edited, snapshot, saved, snapshot);
      expect(stale.kind === 'ready' && stale.question).toBeNull(); // unclaimed when it opened: nothing to ask
      const r = freshSaveCheck(edited, snapshot, saved, { bill, rows, claims: [claim('comp', 'pat')] });
      expect(r.kind === 'ready' && r.question).toBe("Sharing Police comp with everyone removes 1 person's claim. Continue?");
      expect(r.kind === 'ready' && r.args.splitClaimedIds).toEqual(['comp']);
    });

    it('asks about a discount someone claimed after the form opened that the save removes (0.00)', () => {
      const snapshot = { bill, rows, claims: [] as SavedClaim[] };
      const { draft, saved } = draftFromSaved(bill, rows, []);
      const compId = draft.discounts[0]!.id;
      const edited: BillDraft = {
        ...draft,
        discounts: draft.discounts.map((x) => (x.id === compId ? { ...x, amount: '0.00' } : x)),
        totals: { ...draft.totals, subtotal: '30.03', total: '32.43' },
      };
      const r = freshSaveCheck(edited, snapshot, saved, { bill, rows, claims: [claim('comp', 'pat')] });
      expect(r.kind === 'ready' && r.question).toBe('Saving deletes Police comp, which 1 person claimed. Continue?');
    });

    it('asks about a deleted discount someone claimed after the host deleted it without a question', () => {
      const snapshot = { bill, rows, claims: [] as SavedClaim[] };
      const { draft, saved } = draftFromSaved(bill, rows, []);
      const edited: BillDraft = { ...draft, discounts: [], totals: { ...draft.totals, subtotal: '30.03', total: '32.43' } };
      const r = freshSaveCheck(edited, snapshot, saved, { bill, rows, claims: [claim('comp', 'pat')] });
      expect(r.kind === 'ready' && r.question).toBe('Saving deletes Police comp, which 1 person claimed. Continue?');
      // Already confirmed at delete time: no second question.
      const claimed = { bill, rows, claims: [claim('comp', 'pat')] };
      const opened = draftFromSaved(bill, rows, claimed.claims);
      const again = freshSaveCheck({ ...opened.draft, discounts: [], totals: edited.totals }, claimed, opened.saved, {
        ...claimed,
        claims: [...claimed.claims, claim('comp', 'sam')],
      });
      expect(again.kind === 'ready' && again.question).toBeNull();
    });
  });
});
