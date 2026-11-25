// answers:draft / answers:check on temp folders (synthetic data only; no real receipt text).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAnswer } from '../lib/receiptAnswers';
import { assignSet, type ExpectedReceipt } from '../lib/receiptEval';
import { runCheck, runDraft, type Dirs } from './answers';
import { loadGroundTruth, show } from './evalFiles';

let root: string;
let dirs: Dirs;
let logs: string[];
let errs: string[];
const log = (s: string) => logs.push(s);
const logErr = (s: string) => errs.push(s);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'answers-test-'));
  dirs = { photosDir: join(root, 'receipts'), answersDir: join(root, 'receipts', 'answers'), evalDir: join(root, 'eval') };
  mkdirSync(dirs.photosDir);
  mkdirSync(dirs.evalDir);
  logs = [];
  errs = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const photo = (file: string) => writeFileSync(join(dirs.photosDir, file), 'not really a jpeg');
const ocr = (name: string, lines: string[]) =>
  writeFileSync(join(dirs.evalDir, `${name}.web-current.ocr.json`), JSON.stringify({ version: 1, variant: 'web-current', lines: lines.map((text) => ({ text })) }));
const answer = (base: string) => readFileSync(join(dirs.answersDir, `${base}.txt`), 'utf8');
const sets = () => JSON.parse(readFileSync(join(dirs.evalDir, 'sets.json'), 'utf8')) as { sets: Record<string, { set: string; setReason: string }> };
const draft = (extra: Partial<Parameters<typeof runDraft>[0]> = {}) =>
  runDraft({ ...dirs, variant: 'web-current', force: [], usedBeforeSplit: [], blank: false, now: () => new Date('2026-11-23T10:00:00Z'), ...extra }, log, logErr);

function legacy(name: string, over: Partial<ExpectedReceipt> = {}): void {
  const e: ExpectedReceipt = {
    version: 1,
    status: 'draft',
    set: 'tuning',
    setReason: 'used-before-split',
    photo: `receipts/${name}.jpeg`,
    items: [{ name: 'Soup', qty: 2, totalCents: 1300 }],
    subtotalCents: 1300,
    taxCents: 104,
    tipCents: null,
    feesCents: null,
    discounts: [{ label: 'Coupon', cents: 100, appliesTo: 'total' }],
    totalCents: 1304,
    ...over,
  };
  writeFileSync(join(dirs.evalDir, `${name}.expected.json`), JSON.stringify(e));
}

describe('answers:draft', () => {
  it('pre-fills a draft from the web-current read, named after the photo, with a how-to header', () => {
    photo('Taco_Stand.jpeg');
    ocr('taco-stand', ['Fish Tacos 12.50', 'Subtotal 12.50', 'Total 12.50']);
    expect(draft()).toBe(0);
    const text = answer('Taco_Stand');
    // Labelled with the --photos folder it came from (R11), not a fixed receipts/.
    expect(text).toContain(`# Answer for photo: ${show(join(dirs.photosDir, 'Taco_Stand.jpeg'))}`);
    expect(text).toContain('docs/setup/receipt-answers.md');
    expect(text.trimEnd().endsWith('checked: no')).toBe(true);
    const parsed = parseAnswer(text, 'x');
    expect(parsed.ok && parsed.value.items.map((i) => i.totalCents)).toEqual([1250]);
    expect(sets().sets['taco-stand']).toEqual({ set: assignSet('taco-stand'), setReason: 'hash' });
  });

  it('migrates an old expected.json faithfully, keeping its set, and keeps checked when it was checked', () => {
    photo('soup-place.jpeg');
    photo('done-place.jpeg');
    ocr('soup-place', ['Something Else 99.00']); // must not be used: the old file wins
    legacy('soup-place');
    legacy('done-place', { status: 'checked', set: 'heldout', setReason: 'hash' });
    expect(draft()).toBe(0);
    const a = parseAnswer(answer('soup-place'), 'x');
    expect(a.ok && a.value).toEqual({
      checked: false,
      items: [{ name: 'Soup', qty: 2, totalCents: 1300 }],
      subtotalCents: 1300,
      taxCents: 104,
      tipCents: null,
      feesCents: null,
      discounts: [{ label: 'Coupon', cents: 100, appliesTo: 'total' }],
      totalCents: 1304,
    });
    const b = parseAnswer(answer('done-place'), 'x');
    expect(b.ok && b.value.checked).toBe(true);
    expect(sets().sets).toEqual({
      'done-place': { set: 'heldout', setReason: 'hash' },
      'soup-place': { set: 'tuning', setReason: 'used-before-split' },
    });
    // The old files are left as they were.
    expect(existsSync(join(dirs.evalDir, 'soup-place.expected.json'))).toBe(true);
  });

  it('never overwrites an answer file; --force keeps a .bak first', () => {
    photo('a.jpeg');
    ocr('a', ['Tea 2.00']);
    mkdirSync(dirs.answersDir, { recursive: true });
    writeFileSync(join(dirs.answersDir, 'a.txt'), 'my edits\n');
    expect(draft()).toBe(0);
    expect(answer('a')).toBe('my edits\n');
    expect(draft({ force: ['a.jpeg'] })).toBe(0);
    expect(answer('a')).toContain('Tea');
    const backups = readdirSync(dirs.answersDir).filter((f) => f.endsWith('.bak'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dirs.answersDir, backups[0] ?? ''), 'utf8')).toBe('my edits\n');
  });

  it('records a set once and never changes it, even when asked to', () => {
    photo('noodle-bar.jpeg'); // hashes to heldout
    ocr('noodle-bar', ['Ramen 14.00']);
    expect(draft()).toBe(0);
    expect(sets().sets['noodle-bar']).toEqual({ set: 'heldout', setReason: 'hash' });
    expect(draft({ usedBeforeSplit: ['noodle-bar'] })).toBe(1);
    expect(errs.join('\n')).toContain('already recorded as heldout');
    expect(sets().sets['noodle-bar']).toEqual({ set: 'heldout', setReason: 'hash' });
  });

  it('puts --used-before-split photos in tuning', () => {
    photo('noodle-bar.jpeg');
    expect(draft({ usedBeforeSplit: ['noodle-bar.jpeg'], blank: true })).toBe(0);
    expect(sets().sets['noodle-bar']).toEqual({ set: 'tuning', setReason: 'used-before-split' });
  });

  it('skips a photo with no read unless --blank, and rejects unknown names', () => {
    photo('a.jpeg');
    expect(draft()).toBe(0);
    expect(existsSync(join(dirs.answersDir, 'a.txt'))).toBe(false);
    expect(logs.join('\n')).toContain('npm run ocr:harness -- --variants web-current');
    expect(draft({ blank: true })).toBe(0);
    expect(answer('a').trimEnd().endsWith('checked: no')).toBe(true);
    expect(draft({ force: ['nope'] })).toBe(1);
  });

  it('does not migrate an invalid expected.json (and leaves it alone)', () => {
    photo('a.jpeg');
    writeFileSync(join(dirs.evalDir, 'a.expected.json'), '{"version":1,"status":"draft"}');
    expect(draft()).toBe(1);
    expect(existsSync(join(dirs.answersDir, 'a.txt'))).toBe(false);
    expect(errs.join('\n')).toContain('not moving');
  });
});

describe('answers:check and the eval loader', () => {
  it('lists checked, draft, missing and errors, and fails only on errors', () => {
    ['ok.jpeg', 'draft.jpeg', 'missing.jpeg'].forEach(photo);
    mkdirSync(dirs.answersDir);
    writeFileSync(join(dirs.answersDir, 'ok.txt'), '1 Soup 6.50\nsubtotal 6.50\ntotal 6.50\nchecked: yes\n');
    writeFileSync(join(dirs.answersDir, 'draft.txt'), '1 Soup 6.50\ntotal 9.00\n');
    writeFileSync(join(dirs.answersDir, 'stray.txt'), '1 Soup 6.50\n');
    expect(runCheck(dirs, log, logErr)).toBe(0);
    const text = logs.join('\n');
    expect(text).toContain('1 checked, 1 draft, 1 missing, 0 with errors');
    expect(text).toMatch(/CHECKED .*ok\.txt/);
    expect(text).toContain('adds up');
    expect(text).toContain("doesn't add up: items + tax + tip + fees - discounts = 6.50 but total is 9.00");
    expect(text).toMatch(/MISSING .*missing\.jpeg/);
    expect(text).toMatch(/stray\.txt: no photo/);

    writeFileSync(join(dirs.answersDir, 'draft.txt'), '1 Soup 6.5\n');
    logs = [];
    expect(runCheck(dirs, log, logErr)).toBe(1);
    expect(logs.join('\n')).toContain('draft.txt line 1: price must look like 12.50');
  });

  it('prefers the .txt over an old expected.json, and uses the recorded set', () => {
    photo('noodle-bar.jpeg');
    legacy('noodle-bar', { status: 'checked', items: [{ name: 'Old', qty: 1, totalCents: 100 }] });
    mkdirSync(dirs.answersDir);
    writeFileSync(join(dirs.answersDir, 'noodle-bar.txt'), '1 Ramen 14.00\nchecked: yes\n');
    writeFileSync(join(dirs.evalDir, 'sets.json'), JSON.stringify({ version: 1, sets: { 'noodle-bar': { set: 'tuning', setReason: 'used-before-split' } } }));
    const { truths } = loadGroundTruth(dirs);
    expect(truths).toHaveLength(1);
    expect(truths[0]?.expected).toMatchObject({ status: 'checked', set: 'tuning', setReason: 'used-before-split', items: [{ name: 'Ramen' }] });
  });

  it('falls back to an old expected.json when there is no .txt, and to the hash with no record', () => {
    photo('noodle-bar.jpeg');
    photo('other.jpeg');
    legacy('noodle-bar', { status: 'checked' });
    mkdirSync(dirs.answersDir);
    writeFileSync(join(dirs.answersDir, 'other.txt'), '1 Tea 2.00\nchecked: yes\n');
    const { truths } = loadGroundTruth(dirs);
    expect(truths.find((t) => t.name === 'noodle-bar')).toMatchObject({ source: 'expected-json', state: 'checked' });
    expect(truths.find((t) => t.name === 'other')?.expected).toMatchObject({ set: assignSet('other'), setReason: 'hash' });
  });

  it('flags two photos that would share one answer file', () => {
    photo('a.jpeg');
    photo('a.png');
    expect(runCheck(dirs, log, logErr)).toBe(1);
    expect(logs.join('\n')).toContain('would share the answer file');
  });

  it('refuses to go on with a broken set record', () => {
    photo('a.jpeg');
    writeFileSync(join(dirs.evalDir, 'sets.json'), '{"version":1,"sets":{"a":{"set":"x","setReason":"hash"}}}');
    expect(runCheck(dirs, log, logErr)).toBe(1);
    expect(draft({ blank: true })).toBe(1);
    expect(existsSync(join(dirs.answersDir, 'a.txt'))).toBe(false);
  });
});
