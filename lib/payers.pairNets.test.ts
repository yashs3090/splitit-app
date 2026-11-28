// pairNetsTo (who-paid A-28b): the pair nets paymentsMovedBy needs, so screens never import
// lib/transfers. A separate file so lib/payers.test.ts (Task 1's) stays as it was.
import { pairNetsTo, paymentsMovedBy } from './payers';
import { pairState, type Payment } from './transfers';

const A = 'a';
const B = 'b';
const D = 'd';
const E = 'e';
const T1 = '2026-11-27T19:00:00.000001Z';
const T2 = '2026-11-27T19:05:00Z';

const pay = (id: string, fromId: string, toId: string, cents: number, at = T1): Payment => ({
  id,
  fromId,
  toId,
  cents,
  method: 'venmo',
  planKey: null,
  at,
});

describe('pairNetsTo', () => {
  it("gives contract P's net on every (from, to) pair toward each payer, the same as pairState", () => {
    const entries = [pay('1', D, A, 1500), pay('2', E, A, 900), pay('3', A, E, 300, T2), pay('4', D, B, 700)];
    const nets = pairNetsTo(entries, [A, B], [A, B, D, E]);
    expect(nets).toEqual([
      { fromId: B, toId: A, netCents: 0 },
      { fromId: D, toId: A, netCents: 1500 },
      { fromId: E, toId: A, netCents: 600 },
      { fromId: A, toId: B, netCents: 0 },
      { fromId: D, toId: B, netCents: 700 },
      { fromId: E, toId: B, netCents: 0 },
    ]);
    for (const n of nets) expect(n.netCents).toBe(pairState(entries, n.fromId, n.toId).net);
  });

  it('skips a person paired with themself and repeats no pair (duplicate ids are read once)', () => {
    const nets = pairNetsTo([pay('1', D, A, 100)], [A, A], [A, D, D]);
    expect(nets).toEqual([{ fromId: D, toId: A, netCents: 100 }]);
  });

  it("feeds paymentsMovedBy directly: switching A's bill to B moves D's and E's payments", () => {
    const entries = [pay('1', D, A, 1500), pay('2', E, A, 900)];
    expect(paymentsMovedBy(pairNetsTo(entries, [A], [A, B, D, E]), [A], [B])).toEqual([
      { fromId: D, toId: A, cents: 1500 },
      { fromId: E, toId: A, cents: 900 },
    ]);
  });

  it('throws on a bad ledger row, like pairState (a bad row never reads as "no payments")', () => {
    expect(() => pairNetsTo([pay('1', D, A, 0)], [A], [D])).toThrow(RangeError);
    expect(() => pairNetsTo([pay('1', D, A, 12.5)], [A], [D])).toThrow(RangeError);
  });

  it('no people or no payers: no pairs', () => {
    expect(pairNetsTo([pay('1', D, A, 100)], [], [A, D])).toEqual([]);
    expect(pairNetsTo([pay('1', D, A, 100)], [A], [])).toEqual([]);
  });
});
