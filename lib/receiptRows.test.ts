import { toRows } from './receiptRows';
import type { RecognizedLine } from './receiptTypes';

const at = (text: string, x: number, y: number, width = 200, height = 40): RecognizedLine => ({
  text,
  box: { x, y, width, height },
});

describe('toRows', () => {
  it('returns box-less lines in their original order, trimmed and collapsed', () => {
    expect(toRows({ lines: [{ text: '  Burger   12.99 ' }, { text: 'Fries\t3.99' }, { text: 'Subtotal 16.98' }] })).toEqual([
      'Burger 12.99',
      'Fries 3.99',
      'Subtotal 16.98',
    ]);
  });

  it('drops empty and whitespace-only lines', () => {
    expect(toRows({ lines: [{ text: '' }, { text: '   ' }, { text: 'Tea 2.00' }] })).toEqual(['Tea 2.00']);
    expect(toRows({ lines: [at('', 0, 0), at('Tea 2.00', 0, 100)] })).toEqual(['Tea 2.00']);
  });

  it('returns [] for no lines', () => {
    expect(toRows({ lines: [] })).toEqual([]);
  });

  it('pairs Vision-style separate name and price observations on the same y', () => {
    // Vision returns all the names, then all the prices, as separate observations.
    const lines = [
      at('Burger', 40, 200),
      at('Fries', 40, 260),
      at('Subtotal', 40, 320),
      at('16.98', 600, 323, 90),
      at('3.99', 600, 258, 80),
      at('12.99', 600, 204, 90),
    ];
    expect(toRows({ lines })).toEqual(['Burger 12.99', 'Fries 3.99', 'Subtotal 16.98']);
  });

  it('sorts top to bottom, then left to right within a row', () => {
    const lines = [at('Total', 40, 500), at('B', 300, 100), at('A', 40, 102), at('9.99', 600, 498)];
    expect(toRows({ lines })).toEqual(['A B', 'Total 9.99']);
  });

  it('keeps lines whose centres differ by more than one line height in separate rows', () => {
    const lines = [at('Soup', 40, 100), at('6.00', 600, 141)]; // centres 41px apart, height 40
    expect(toRows({ lines })).toEqual(['Soup', '6.00']);
  });

  it('groups lines within half the median line height, and splits beyond it', () => {
    expect(toRows({ lines: [at('Soup', 40, 100), at('6.00', 600, 119)] })).toEqual(['Soup 6.00']);
    expect(toRows({ lines: [at('Soup', 40, 100), at('6.00', 600, 122)] })).toEqual(['Soup', '6.00']);
  });

  it('uses the median height, so one tall line does not merge neighbouring rows', () => {
    const lines = [
      at('LOGO', 40, 0, 400, 300), // centre 150
      at('Tea', 40, 400),
      at('2.00', 600, 400),
      at('Cake', 40, 450),
      at('4.00', 600, 450),
    ];
    expect(toRows({ lines })).toEqual(['LOGO', 'Tea 2.00', 'Cake 4.00']);
  });

  it('falls back to the returned order when any line lacks a box', () => {
    const lines: RecognizedLine[] = [at('Fries', 40, 260), { text: 'Burger' }, at('12.99', 600, 200)];
    expect(toRows({ lines })).toEqual(['Fries', 'Burger', '12.99']);
  });

  it('de-skews a ~2 degree tilt so names and prices still pair (R1)', () => {
    // Prices sit 21px lower than their names: more than half a line height (20px).
    const tilt = 21;
    const lines = [
      at('Burger', 40, 200, 260),
      at('Fries', 40, 260, 260),
      at('Subtotal', 40, 320, 260),
      at('16.98', 620, 320 + tilt, 90),
      at('3.99', 620, 260 + tilt, 90),
      at('12.99', 620, 200 + tilt, 90),
    ];
    expect(toRows({ lines })).toEqual(['Burger 12.99', 'Fries 3.99', 'Subtotal 16.98']);
  });

  it('de-skews a tilt in the other direction too', () => {
    const lines = [
      at('Tea', 40, 200, 260),
      at('2.00', 620, 179, 90),
      at('Cake', 40, 260, 260),
      at('4.00', 620, 239, 90),
      at('Total', 40, 320, 260),
      at('6.00', 620, 299, 90),
    ];
    expect(toRows({ lines })).toEqual(['Tea 2.00', 'Cake 4.00', 'Total 6.00']);
  });
});
