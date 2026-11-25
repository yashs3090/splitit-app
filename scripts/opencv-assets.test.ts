// scripts/opencv-assets.mjs decides whether public/opencv/ is built by reading WEB_CV_PREPROCESS
// from config.ts as text (spec A1 Q2). This checks it reads the same value the app imports, and
// that the SPLITIT_OPENCV_ASSETS override works, by running the real script.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { WEB_CV_PREPROCESS } from '../lib/scanPipeline/config';

const script = join(__dirname, 'opencv-assets.mjs');
function print(env: Record<string, string> = {}, flag = '--print'): string {
  const { SPLITIT_OPENCV_ASSETS: _drop, SPLITIT_OPENCV_OUT: _drop2, ...rest } = process.env;
  return execFileSync(process.execPath, [script, flag], { env: { ...rest, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('opencv-assets flag', () => {
  it('follows WEB_CV_PREPROCESS by default', () => {
    expect(print()).toBe(String(WEB_CV_PREPROCESS));
  });

  it('SPLITIT_OPENCV_ASSETS=1 / 0 override it; anything else is an error', () => {
    expect(print({ SPLITIT_OPENCV_ASSETS: '1' })).toBe('true');
    expect(print({ SPLITIT_OPENCV_ASSETS: '0' })).toBe('false');
    expect(() => print({ SPLITIT_OPENCV_ASSETS: 'yes' })).toThrow();
  });
});

describe('opencv-assets output folder (harness-private builds)', () => {
  it('defaults to public/opencv/', () => {
    expect(print({}, '--print-out')).toBe(join(__dirname, '..', 'public', 'opencv'));
  });

  it('SPLITIT_OPENCV_OUT moves it, only as an absolute path and only with SPLITIT_OPENCV_ASSETS=1', () => {
    const dir = join(__dirname, '..', 'eval', 'receipts', '.harness-opencv-test');
    expect(print({ SPLITIT_OPENCV_ASSETS: '1', SPLITIT_OPENCV_OUT: dir }, '--print-out')).toBe(dir);
    expect(() => print({ SPLITIT_OPENCV_ASSETS: '1', SPLITIT_OPENCV_OUT: 'relative/dir' }, '--print-out')).toThrow();
    expect(() => print({ SPLITIT_OPENCV_OUT: dir }, '--print-out')).toThrow();
    expect(() => print({ SPLITIT_OPENCV_ASSETS: '0', SPLITIT_OPENCV_OUT: dir }, '--print-out')).toThrow();
  });
});
