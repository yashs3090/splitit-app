// The eval's ground-truth loader and what it lets the eval score (synthetic data only; no real
// receipt text). Review findings R6 (held-out answer errors stay hidden until --confirm), R7 (an
// unrecorded set is never scored) and R11 (the photo label follows --photos).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assignSet, type EvalSet } from '../lib/receiptEval';
import type { Dirs } from './answers';
import { loadGroundTruth, missingVariantsError, ocrVariants, selectScorable, show } from './evalFiles';

let root: string;
let dirs: Dirs;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'evalfiles-test-'));
  dirs = { photosDir: join(root, 'my-photos'), answersDir: join(root, 'answers'), evalDir: join(root, 'eval') };
  for (const d of Object.values(dirs)) mkdirSync(d);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const photo = (file: string) => writeFileSync(join(dirs.photosDir, file), 'not really a jpeg');
const answerFile = (base: string, text: string) => writeFileSync(join(dirs.answersDir, `${base}.txt`), text);
const record = (sets: Record<string, EvalSet>) =>
  writeFileSync(
    join(dirs.evalDir, 'sets.json'),
    JSON.stringify({ version: 1, sets: Object.fromEntries(Object.entries(sets).map(([k, set]) => [k, { set, setReason: 'hash' }])) }),
  );
/** Synthetic names whose hash set is known, so each test can pick one of each. */
function nameIn(set: EvalSet): string {
  for (let i = 0; i < 200; i++) if (assignSet(`sample-${i}`) === set) return `sample-${i}`;
  throw new Error('no name');
}

describe('loadGroundTruth: photo label (R11)', () => {
  it('labels the photo with the folder it was read from, not a hard-coded receipts/', () => {
    photo('cafe.jpeg');
    answerFile('cafe', '1 Soup 6.50\nsubtotal 6.50\ntotal 6.50\nchecked: yes\n');
    const { truths } = loadGroundTruth(dirs);
    expect(truths[0]?.expected?.photo).toBe(show(join(dirs.photosDir, 'cafe.jpeg')));
    expect(truths[0]?.expected?.photo).not.toBe('receipts/cafe.jpeg');
  });
});

describe('selectScorable', () => {
  it('scores only checked answers whose set is recorded (R7); an unrecorded one is skipped and says how to record it', () => {
    photo('cafe.jpeg');
    photo('diner.jpeg');
    answerFile('cafe', '1 Soup 6.50\nsubtotal 6.50\ntotal 6.50\nchecked: yes\n');
    answerFile('diner', '1 Tea 2.00\nsubtotal 2.00\ntotal 2.00\nchecked: yes\n');
    record({ cafe: 'tuning' });
    const r = selectScorable(loadGroundTruth(dirs).truths, null, { confirm: false });
    expect(r.checked.map((c) => c.name)).toEqual(['cafe']);
    expect(r.skipped).toEqual([{ name: 'diner', why: expect.stringContaining('npm run answers:draft') }]);
    expect(r.skipped[0]?.why).toContain('set not recorded');
    expect(r.failed).toBe(false);
  });

  it('an old expected.json carries its own set, so it still counts as recorded', () => {
    writeFileSync(
      join(dirs.evalDir, 'legacy.expected.json'),
      JSON.stringify({
        version: 1, status: 'checked', set: 'tuning', setReason: 'used-before-split', photo: 'receipts/legacy.jpeg',
        items: [{ name: 'Soup', qty: 1, totalCents: 650 }], subtotalCents: 650, taxCents: null, tipCents: null, feesCents: null, discounts: [], totalCents: 650,
      }),
    );
    const r = selectScorable(loadGroundTruth(dirs).truths, null, { confirm: false });
    expect(r.checked.map((c) => c.name)).toEqual(['legacy']);
  });

  it('an invalid held-out answer prints only its file name until --confirm (R6); tuning errors print in full', () => {
    const held = nameIn('heldout');
    const tune = nameIn('tuning');
    photo(`${held}.jpeg`);
    photo(`${tune}.jpeg`);
    answerFile(held, '1 Secret Dish 6.5\nchecked: yes\n');
    answerFile(tune, '1 Plain Dish 6.5\nchecked: yes\n');
    record({ [held]: 'heldout', [tune]: 'tuning' });
    const truths = loadGroundTruth(dirs).truths;

    const hidden = selectScorable(truths, null, { confirm: false });
    expect(hidden.failed).toBe(true);
    const heldErrors = hidden.errors.filter((e) => e.includes(held));
    expect(heldErrors).toHaveLength(1);
    expect(heldErrors[0]).toContain(`${held}.txt`);
    expect(heldErrors[0]).toContain('--confirm');
    expect(hidden.errors.join('\n')).not.toContain('Secret Dish');
    expect(hidden.errors.join('\n')).not.toMatch(new RegExp(`${held}\\.txt line`));
    expect(hidden.errors.some((e) => e.includes(`${tune}.txt line 1`))).toBe(true);

    const shown = selectScorable(truths, null, { confirm: true });
    expect(shown.errors.some((e) => e.includes(`${held}.txt line 1`))).toBe(true);
  });

  it('drafts and missing answers are listed and skipped; --only picks by name, photo file or answer name', () => {
    photo('cafe.jpeg');
    photo('diner.jpeg');
    photo('bistro.jpeg');
    answerFile('cafe', '1 Soup 6.50\nsubtotal 6.50\ntotal 6.50\nchecked: yes\n');
    answerFile('diner', '1 Tea 2.00\n');
    record({ cafe: 'tuning', diner: 'tuning', bistro: 'tuning' });
    const truths = loadGroundTruth(dirs).truths;
    const all = selectScorable(truths, null, { confirm: false });
    expect(all.checked.map((c) => c.name)).toEqual(['cafe']);
    expect(all.skipped.map((s) => s.name).sort()).toEqual(['bistro', 'diner']);
    expect(selectScorable(truths, new Set(['cafe.jpeg']), { confirm: false }).checked).toHaveLength(1);
    expect(selectScorable(truths, new Set(['diner']), { confirm: false }).checked).toHaveLength(0);
  });
});

describe('a variant with no ocr.json files (eval UX)', () => {
  const ocr = (name: string, variant: string) => writeFileSync(join(dirs.evalDir, `${name}.${variant}.ocr.json`), '{}');

  it('ocrVariants lists each variant that has a file, once, sorted, ignoring other files', () => {
    ocr('cafe', 'web-current');
    ocr('diner', 'web-current');
    ocr('cafe', 'web-crop-th40');
    writeFileSync(join(dirs.evalDir, 'cafe.expected.json'), '{}');
    writeFileSync(join(dirs.evalDir, 'cafe.web-current.binary.png'), '');
    expect(ocrVariants(dirs.evalDir)).toEqual(['web-crop-th40', 'web-current']);
    expect(ocrVariants(join(root, 'nope'))).toEqual([]);
  });

  it('missingVariantsError names the missing variant(s) and lists the ones that exist', () => {
    ocr('cafe', 'web-current');
    expect(missingVariantsError(dirs.evalDir, ['web-current'])).toBeNull();
    const one = missingVariantsError(dirs.evalDir, ['web-current', 'no-such-variant']);
    expect(one).toContain('variant no-such-variant');
    expect(one).toContain('Variants with ocr.json files: web-current.');
    const two = missingVariantsError(dirs.evalDir, ['a', 'b', 'a']);
    expect(two).toContain('variants a, b in');
    expect(missingVariantsError(join(root, 'empty'), ['web-current'])).toContain('No variant has ocr.json files there yet.');
  });

  it('npm run eval -- --variant <unknown> says so and exits non-zero (all three modes)', () => {
    photo('cafe.jpeg');
    answerFile('cafe', '1 Soup 6.50\nsubtotal 6.50\ntotal 6.50\nchecked: yes\n');
    record({ cafe: 'tuning' });
    ocr('cafe', 'web-current');
    const cli = (...extra: string[]) =>
      spawnSync(
        process.execPath,
        [require.resolve('tsx/cli'), join(__dirname, 'eval-receipts.ts'), '--dir', dirs.evalDir, '--photos', dirs.photosDir, '--answers', dirs.answersDir, ...extra],
        { encoding: 'utf8' },
      );
    for (const args of [['--variant', 'no-such-variant'], ['--compare', 'web-current,no-such-variant'], ['--flow', 'no-such-variant,web-current']]) {
      const r = cli(...args);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('No ocr.json files for variant no-such-variant');
      expect(r.stderr).toContain('Variants with ocr.json files: web-current.');
      expect(r.stdout).not.toContain('No checked receipts to score');
    }
  }, 30_000);
});
