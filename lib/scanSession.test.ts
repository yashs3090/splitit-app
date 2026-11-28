import { getFixture } from './fixtures/receipts';
import {
  clearAttachFailure,
  clearGroupReceipt,
  clearScanGroup,
  clearScanResult,
  getAttachFailure,
  getScanGroup,
  getScanResult,
  setAttachFailure,
  setScanGroup,
  setScanResult,
} from './scanSession';

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

describe('scanSession: the group a receipt goes into (groups T17, GR-6)', () => {
  const BILL = '11111111-2222-4333-8444-555555555555';
  const GROUP = '99999999-0000-4000-8000-000000000009';
  afterEach(() => clearGroupReceipt());

  it('holds the group apart from the scan result, so clearing the result keeps it', () => {
    expect(getScanGroup()).toBeNull();
    setScanGroup({ groupId: GROUP, name: 'Tahoe trip' });
    setScanResult(getFixture('diner-simple').expected);
    clearScanResult();
    expect(getScanGroup()).toEqual({ groupId: GROUP, name: 'Tahoe trip' });
    clearScanGroup();
    expect(getScanGroup()).toBeNull();
  });

  it('an attach failure is returned only for its bill, and cleared only by that bill', () => {
    setAttachFailure({ billId: BILL, groupId: GROUP, groupName: 'Tahoe trip' });
    expect(getAttachFailure('other')).toBeNull();
    expect(getAttachFailure(BILL)).toEqual({ billId: BILL, groupId: GROUP, groupName: 'Tahoe trip' });
    clearAttachFailure('other');
    expect(getAttachFailure(BILL)).not.toBeNull();
    clearAttachFailure(BILL);
    expect(getAttachFailure(BILL)).toBeNull();
  });

  it('clearGroupReceipt (sign-out) drops both', () => {
    setScanGroup({ groupId: GROUP, name: 'Tahoe trip' });
    setAttachFailure({ billId: BILL, groupId: GROUP, groupName: 'Tahoe trip' });
    clearGroupReceipt();
    expect(getScanGroup()).toBeNull();
    expect(getAttachFailure(BILL)).toBeNull();
  });
});
