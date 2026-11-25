// The harness's private OpenCV folder (spec Task 9 harness fix): built with the repo's own scripts
// into a folder of its own, checked for missing files, crash leftovers cleaned. public/opencv/ is
// never touched. Uses temporary folders; no receipt photo involved.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHarnessCvAssets, CV_ASSET_FILES, harnessCvDir, missingCvAssets, removeStaleHarnessCvDirs } from './cvAssets';

const ROOT = join(__dirname, '..', '..');
const PUBLIC_OPENCV = join(ROOT, 'public', 'opencv');
const snapshot = () => (existsSync(PUBLIC_OPENCV) ? readdirSync(PUBLIC_OPENCV).map((f) => `${f}:${statSync(join(PUBLIC_OPENCV, f)).mtimeMs}`).sort() : null);

describe('harness OpenCV assets', () => {
  let evalDir: string;
  beforeAll(() => {
    evalDir = mkdtempSync(join(tmpdir(), 'ocr-harness-cvassets-'));
  });
  afterAll(() => rmSync(evalDir, { recursive: true, force: true }));

  it('builds opencv.js and the worker into the private folder, leaving public/opencv/ exactly as it was', () => {
    const before = snapshot();
    const dir = harnessCvDir(evalDir, 4242);
    expect(missingCvAssets(dir)).toEqual([...CV_ASSET_FILES]);
    buildHarnessCvAssets(ROOT, dir, 'ignore');
    expect(missingCvAssets(dir)).toEqual([]);
    expect(statSync(join(dir, 'opencv.js')).size).toBeGreaterThan(1_000_000);
    expect(snapshot()).toEqual(before);
    // A deleted file is noticed (the per-photo re-check).
    unlinkSync(join(dir, 'receipt-cv-worker.js'));
    expect(missingCvAssets(dir)).toEqual(['receipt-cv-worker.js']);
  }, 60000);

  it('removes leftovers of dead harness runs only; a live run\'s folder and other files stay', () => {
    for (const n of ['.harness-opencv-111', '.harness-opencv-222', 'keep-me']) mkdirSync(join(evalDir, n), { recursive: true });
    const removed = removeStaleHarnessCvDirs(evalDir, (pid) => pid === 222);
    expect(removed).toContain('.harness-opencv-111');
    expect(removed).not.toContain('.harness-opencv-222');
    expect(existsSync(join(evalDir, '.harness-opencv-222'))).toBe(true);
    expect(existsSync(join(evalDir, 'keep-me'))).toBe(true);
  });
});
