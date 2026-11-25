import { getFixture } from './fixtures/receipts';
import { clearScanResult, getScanResult, setScanResult } from './scanSession';

afterEach(() => clearScanResult());

describe('scanSession', () => {
  it('starts empty', () => {
    expect(getScanResult()).toBeNull();
  });

  it('holds the last result set, and clear empties it', () => {
    const a = getFixture('diner-simple').expected;
    const b = getFixture('modifiers').expected;
    setScanResult(a);
    expect(getScanResult()).toBe(a);
    setScanResult(b);
    expect(getScanResult()).toBe(b);
    clearScanResult();
    expect(getScanResult()).toBeNull();
  });
});
