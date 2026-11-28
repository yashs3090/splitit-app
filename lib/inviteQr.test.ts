import { INVITE_QR_COPY, qrSheetTitle, qrTileLayout, QR_MAX, QR_MIN } from './inviteQr';

describe('qrSheetTitle', () => {
  it('names the group', () => {
    expect(qrSheetTitle({ kind: 'group', name: 'Tahoe trip' })).toBe('Scan to join Tahoe trip');
  });

  it('falls back to "this group" when the name is blank or missing', () => {
    expect(qrSheetTitle({ kind: 'group', name: '   ' })).toBe('Scan to join this group');
    expect(qrSheetTitle({ kind: 'group' })).toBe('Scan to join this group');
  });

  it('collapses whitespace in the name', () => {
    expect(qrSheetTitle({ kind: 'group', name: '  Tahoe \n trip ' })).toBe('Scan to join Tahoe trip');
  });

  it('a bill is always "this bill"', () => {
    expect(qrSheetTitle({ kind: 'bill' })).toBe('Scan to join this bill');
  });
});

describe('qrTileLayout', () => {
  const tile = (l: { size: number; quietZone: number }) => l.size + 2 * l.quietZone;

  it('fills a 390-pt phone: the tile fits the sheet width (16-pt padding each side)', () => {
    const l = qrTileLayout(390, 844);
    expect(tile(l)).toBeLessThanOrEqual(390 - 32);
    expect(l.size).toBeGreaterThan(200);
  });

  it('keeps a quiet zone of at least 4 modules even for the smallest code (25 modules)', () => {
    for (const [w, h] of [[320, 568], [390, 844], [430, 932], [1280, 800]] as const) {
      const l = qrTileLayout(w, h);
      expect(l.quietZone).toBeGreaterThanOrEqual((l.size / 25) * 4);
    }
  });

  it('is capped on wide screens and never smaller than the minimum', () => {
    expect(qrTileLayout(1280, 1000).size).toBe(QR_MAX);
    expect(qrTileLayout(200, 300).size).toBe(QR_MIN);
  });

  it('shrinks on a short (landscape) window so the link and buttons stay close', () => {
    expect(qrTileLayout(844, 390).size).toBeLessThan(qrTileLayout(390, 844).size);
  });

  it('returns whole points', () => {
    const l = qrTileLayout(377, 701);
    expect(Number.isInteger(l.size)).toBe(true);
    expect(Number.isInteger(l.quietZone)).toBe(true);
  });
});

it('copy has no hide state any more (the QR is a popup)', () => {
  expect(INVITE_QR_COPY).not.toHaveProperty('hide');
  expect(INVITE_QR_COPY.show).toBe('Show QR code');
  expect(INVITE_QR_COPY.imageLabel).toBe('QR code for the invite link');
});
