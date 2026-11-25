// Criterion 62 (docs/specs/2026-11-25-settle-early-and-differences.md, A1.12, Task 10a): the boundary
// tables E (D2) and D (D4) are tested on both sides, and each test's description starts with its
// [E#] / [D#] tag. This test reads the four files from disk and checks the tag sets haven't drifted:
// - E: the same set in settle_early.test.sql and lib/settle.test.ts, and it is exactly E1–E20;
// - D: D1–D20 all in settle_difference.test.sql; the lib table's rows D1–D7 (the rows with a lib
//   `difference` value) in both lib/settle.test.ts and the SQL file; every D tag in the lib tests
//   (lib/settle.test.ts, lib/bills.test.ts) exists in the SQL file. D8–D20 are DB-only by design.
const fs = jest.requireActual<{ readFileSync(file: string, encoding: 'utf8'): string }>('fs');
const read = (path: string): string => fs.readFileSync(`${process.cwd()}/${path}`, 'utf8');

type Tags = { E: Set<number>; D: Set<number> };

/** Every [E#] / [D#] tag in the text, by letter. */
function extractTags(text: string): Tags {
  const tags: Tags = { E: new Set(), D: new Set() };
  for (const m of text.matchAll(/\[(E|D)(\d+)\]/g)) {
    const letter = m[1] as 'E' | 'D';
    tags[letter].add(Number(m[2]));
  }
  return tags;
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const sorted = (s: Iterable<number>): number[] => [...s].sort((a, b) => a - b);
/** Ids in `want` that `have` lacks. */
const missing = (want: Iterable<number>, have: Set<number>): number[] => sorted([...want].filter((n) => !have.has(n)));

const E_ROWS = range(1, 20);
const D_ROWS = range(1, 20);
const D_LIB_ROWS = range(1, 7);

const sqlEarly = extractTags(read('supabase/tests/database/settle_early.test.sql'));
const sqlDiff = extractTags(read('supabase/tests/database/settle_difference.test.sql'));
const libSettle = extractTags(read('lib/settle.test.ts'));
const libBills = extractTags(read('lib/bills.test.ts'));

describe('extractTags and the set comparison', () => {
  it('finds each tag once per id, by letter', () => {
    const t = extractTags("it('[E1] a', …); it('[E1] b'); select ok(x, '[D12] c'); [E20] [X3] [E] E4");
    expect(sorted(t.E)).toEqual([1, 20]);
    expect(sorted(t.D)).toEqual([12]);
  });

  it('reports the id an inline table is missing (the check fails on it)', () => {
    const t = extractTags(range(1, 20).filter((n) => n !== 13).map((n) => `[E${n}]`).join(' '));
    expect(missing(E_ROWS, t.E)).toEqual([13]);
    expect(() => expect(sorted(t.E)).toEqual(E_ROWS)).toThrow();
  });
});

describe('criterion 62: [E#] / [D#] tags match across pgTAP and Jest', () => {
  it('E: settle_early.test.sql has exactly E1–E20', () => {
    expect(sorted(sqlEarly.E)).toEqual(E_ROWS);
  });

  it('E: lib/settle.test.ts has the same set as settle_early.test.sql', () => {
    expect(sorted(libSettle.E)).toEqual(sorted(sqlEarly.E));
  });

  it('D: settle_difference.test.sql has every row D1–D20', () => {
    expect(missing(D_ROWS, sqlDiff.D)).toEqual([]);
  });

  it("D: the lib table's rows D1–D7 appear in lib/settle.test.ts and in the SQL file", () => {
    expect(missing(D_LIB_ROWS, libSettle.D)).toEqual([]);
    expect(missing(D_LIB_ROWS, sqlDiff.D)).toEqual([]);
  });

  it('D: every D tag in the lib tests exists in settle_difference.test.sql', () => {
    expect(missing(libSettle.D, sqlDiff.D)).toEqual([]);
    expect(missing(libBills.D, sqlDiff.D)).toEqual([]);
  });

  it('the SQL files carry no tags of the other table', () => {
    expect(sorted(sqlEarly.D)).toEqual([]);
    expect(sorted(sqlDiff.E)).toEqual([]);
  });
});

export {}; // a module, so these helpers stay file-scoped for tsc
