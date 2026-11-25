// The lazy web OCR engine module (criteria 50 and the asset/settings parts of 51, A3 / Task 9).
import { createWorker, type Page } from 'tesseract.js';

jest.mock('tesseract.js', () => ({ createWorker: jest.fn() }));

import { getFixture } from './fixtures/receipts';
import { parseReceipt } from './receiptText';
import {
  lineTextFromWords,
  mapTesseractResult,
  MIN_SYMBOL_WORD_CONFIDENCE,
  readLines,
  reinitWorker,
  startWorker,
  TESSERACT_ASSET_BASE,
  TESSERACT_PARAMS,
  tesseractPaths,
  toRecognizedText,
} from './webOcrEngine';

function line(text: string, x0: number, y0: number, x1: number, y1: number) {
  return { text, bbox: { x0, y0, x1, y1 } };
}

function pageOf(lines: ReturnType<typeof line>[]): Partial<Page> {
  return { blocks: [{ paragraphs: [{ lines }] }] } as unknown as Partial<Page>;
}

describe('mapTesseractResult (50)', () => {
  it('flattens 2 blocks × 2 paragraphs × 2 lines in order, converting bbox to x/y/width/height', () => {
    const blocks = [0, 1].map((b) => ({
      paragraphs: [0, 1].map((p) => ({
        lines: [0, 1].map((l) => line(` b${b}p${p}l${l} `, 10, 20 + b * 100 + p * 50 + l * 25, 110, 45 + b * 100 + p * 50 + l * 25)),
      })),
    }));
    const out = mapTesseractResult({ blocks } as unknown as Page);
    expect(out.lines.map((l) => l.text)).toEqual([
      'b0p0l0', 'b0p0l1', 'b0p1l0', 'b0p1l1', 'b1p0l0', 'b1p0l1', 'b1p1l0', 'b1p1l1',
    ]);
    expect(out.lines[0]).toEqual({ text: 'b0p0l0', box: { x: 10, y: 20, width: 100, height: 25 } });
  });

  it('drops whitespace-only lines and lines with bad boxes; missing blocks give no lines', () => {
    const out = mapTesseractResult(
      pageOf([
        line('   ', 0, 0, 10, 10),
        line('keep', 0, 0, 10, 10),
        line('nan', Number.NaN, 0, 10, 10),
        line('neg', -1, 0, 10, 10),
        line('inverted', 10, 0, 5, 10),
        line('inf', 0, 0, Number.POSITIVE_INFINITY, 10),
      ]) as Page,
    );
    expect(out.lines.map((l) => l.text)).toEqual(['keep']);
    expect(mapTesseractResult({} as Page)).toEqual({ lines: [] });
    expect(mapTesseractResult({ blocks: null } as unknown as Page)).toEqual({ lines: [] });
    expect(mapTesseractResult(null)).toEqual({ lines: [] });
    expect(mapTesseractResult({ blocks: [{ paragraphs: null }, { paragraphs: [{ lines: null }] }] } as unknown as Page)).toEqual({ lines: [] });
  });

  it('feeds parseReceipt unchanged: diner-simple laid out as Tesseract lines parses to fixture 1', () => {
    const fixture = getFixture('diner-simple');
    const lines = fixture.text.lines.map((l, i) => line(l.text, 40, 100 + i * 40, 600, 130 + i * 40));
    const parsed = parseReceipt(mapTesseractResult(pageOf(lines) as Page));
    expect(parsed).toEqual(fixture.expected);
  });
});

type W = { text: string; confidence: number };
const w = (text: string, confidence: number): W => ({ text, confidence });

function wordLine(words: W[], x0 = 40, y0 = 100, x1 = 600, y1 = 130) {
  // Tesseract's line text keeps wide gaps (preserve_interword_spaces); words carry their own boxes.
  return { text: words.map((x) => x.text).join('    '), bbox: { x0, y0, x1, y1 }, words: words.map((x) => ({ ...x, bbox: { x0, y0, x1, y1 } })) };
}

describe('lineTextFromWords: drops noise words, keeps every letter/digit word', () => {
  it('El Chalan, web pipeline: the Causa row loses "?" but keeps qty, name, low-confidence words and the price', () => {
    // Exact word data Tesseract gave for this row (browser re-encode of the 866×1390 photo, 2026-11-22).
    const words = [w('4', 68), w('CAUSA', 96), w('DE', 96), w('POLLO', 96), w('?', 20), w('RTE', 22), w('$8.95', 32)];
    expect(lineTextFromWords(words)).toBe('4 CAUSA DE POLLO RTE $8.95');
  });

  it('keeps real item words even at confidence 0 (low-resolution receipt, upscaled)', () => {
    expect(lineTextFromWords([w('1', 89), w('S08', 4), w('Cup', 61), w('BIsOuE', 0), w('3.00', 94)])).toBe('1 S08 Cup BIsOuE 3.00');
    expect(lineTextFromWords([w('1', 7), w('RAINTREE', 87), w('Rupy', 45), w('10.00', 92)])).toBe('1 RAINTREE Rupy 10.00');
  });

  it('drops punctuation-only noise whatever its confidence', () => {
    expect(lineTextFromWords([w('©', 48), w('1', 90), w('RAINTREE', 87), w('10.00', 92)])).toBe('1 RAINTREE 10.00');
    for (const junk of ['?', '.', '‘', '’', '©', '¢', '|', '\\', '/', '~~', '«©', '_', '=', ';', ',', '!', '"', '§', '€']) {
      expect(lineTextFromWords([w('Tax', 95), w(junk, 99), w('6.77', 90)])).toBe('Tax 6.77');
    }
  });

  it('keeps symbols the parser reads (modifiers, negatives, $, %, @, #, colon) when confident; drops them below the threshold', () => {
    expect(MIN_SYMBOL_WORD_CONFIDENCE).toBe(50);
    for (const sym of ['+', '-', '$', '%', '@', '&', '#', '#:', '*', '(', ')', ':']) {
      expect(lineTextFromWords([w(sym, 50), w('avocado', 90)])).toBe(`${sym} avocado`);
      expect(lineTextFromWords([w(sym, 49), w('avocado', 90)])).toBe('avocado');
    }
    expect(lineTextFromWords([w('-', Number.NaN), w('x', 90)])).toBe('x');
  });

  it('words with letters or digits are never dropped, including mixed tokens like "(Brunch)" and "Combo)21.95"', () => {
    const words = [w('1', 83), w('Dos', 83), w('(Brunch)', 96), w('Combo)21.95', 59), w('a', 0), w('$', 90), w('8.95', 10)];
    expect(lineTextFromWords(words)).toBe('1 Dos (Brunch) Combo)21.95 a $ 8.95');
  });

  it('returns null (caller falls back to line text) when there is no usable word list; empty when every word is noise', () => {
    expect(lineTextFromWords(undefined)).toBeNull();
    expect(lineTextFromWords(null)).toBeNull();
    expect(lineTextFromWords([])).toBeNull();
    expect(lineTextFromWords([w('?', 90), w('.', 5)])).toBe('');
    expect(lineTextFromWords([{ text: 42 } as unknown as W, w('  ', 90), w(' ok ', 90)])).toBe('ok');
  });
});

describe('mapTesseractResult with word data', () => {
  it('builds each line from its kept words, keeps the line bbox, and drops lines that are all noise', () => {
    const page = pageOf([
      wordLine([w('4', 68), w('CAUSA', 96), w('DE', 96), w('POLLO', 96), w('?', 20), w('RTE', 22), w('$8.95', 32)], 10, 20, 500, 45),
      wordLine([w('«©', 33), w('~~', 40)]),
      line('no words array here', 0, 60, 100, 80),
    ] as ReturnType<typeof line>[]);
    expect(mapTesseractResult(page as Page)).toEqual({
      lines: [
        { text: '4 CAUSA DE POLLO RTE $8.95', box: { x: 10, y: 20, width: 490, height: 25 } },
        { text: 'no words array here', box: { x: 0, y: 60, width: 100, height: 20 } },
      ],
    });
  });

  it('El Chalan rows through the parser: the Causa item is no longer named with a "?"', () => {
    const rows = [
      [w('ITEM', 90), w('QTY', 90), w('PRICE', 90)],
      [w('4', 68), w('CAUSA', 96), w('DE', 96), w('POLLO', 96), w('?', 20), w('RTE', 22), w('$8.95', 32)],
      [w('CEVICHE', 96), w('DE', 93), w('CAMARONES', 90), w('1', 88), w('$16.95', 88), w('a', 94)],
    ];
    const page = pageOf(rows.map((r, i) => wordLine(r, 40, 100 + i * 40, 600, 130 + i * 40)) as ReturnType<typeof line>[]);
    const names = parseReceipt(mapTesseractResult(page as Page)).items.map((i) => i.name);
    expect(names[0]).not.toContain('?');
    expect(names).toContain('CEVICHE DE CAMARONES');
  });
});

describe('engine config', () => {
  it('self-hosts by default and switching to the CDN is one constant (null = library defaults)', () => {
    expect(TESSERACT_ASSET_BASE).toBe('/tesseract');
    expect(tesseractPaths(null)).toEqual({});
    expect(tesseractPaths('/tesseract/')).toEqual({
      workerPath: '/tesseract/worker.min.js',
      corePath: '/tesseract/core',
      langPath: '/tesseract/lang',
      workerBlobURL: false,
    });
  });

  it('uses PSM 6 (one uniform block) and keeps inter-word spaces', () => {
    expect(TESSERACT_PARAMS).toEqual({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
  });

  it('toRecognizedText is mapTesseractResult', () => {
    expect(toRecognizedText).toBe(mapTesseractResult);
  });
});

describe('startWorker (review R4a)', () => {
  const create = createWorker as unknown as jest.Mock;

  function fakeWorker(setParameters: jest.Mock, terminate: jest.Mock = jest.fn().mockResolvedValue(undefined)) {
    return { setParameters, terminate, recognize: jest.fn() };
  }

  beforeEach(() => create.mockReset());

  it('applies the settings and returns the worker', async () => {
    const worker = fakeWorker(jest.fn().mockResolvedValue(undefined));
    create.mockResolvedValue(worker);
    await expect(startWorker(jest.fn(), jest.fn())).resolves.toBe(worker);
    expect(worker.setParameters).toHaveBeenCalledWith(TESSERACT_PARAMS);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('terminates the started worker and rethrows when setParameters rejects', async () => {
    const boom = new Error('setParameters failed');
    const worker = fakeWorker(jest.fn().mockRejectedValue(boom));
    create.mockResolvedValue(worker);
    await expect(startWorker(jest.fn(), jest.fn())).rejects.toBe(boom);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('still rethrows the setParameters error if terminate also rejects', async () => {
    const boom = new Error('setParameters failed');
    const worker = fakeWorker(jest.fn().mockRejectedValue(boom), jest.fn().mockRejectedValue(new Error('terminate failed')));
    create.mockResolvedValue(worker);
    await expect(startWorker(jest.fn(), jest.fn())).rejects.toBe(boom);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});

describe('Tesseract knobs (spec Task 5, criteria 24–25)', () => {
  const create = createWorker as unknown as jest.Mock;
  const PAGE = { blocks: [{ paragraphs: [{ lines: [{ text: 'Total 9.00', bbox: { x0: 0, y0: 0, x1: 90, y1: 20 }, confidence: 87.5 }] }] }] };

  function fakeWorker() {
    return {
      setParameters: jest.fn().mockResolvedValue(undefined),
      terminate: jest.fn().mockResolvedValue(undefined),
      reinitialize: jest.fn().mockResolvedValue(undefined),
      recognize: jest.fn().mockResolvedValue({ data: PAGE }),
    };
  }

  beforeEach(() => create.mockReset());

  it('web-current start-up is today\'s call: three createWorker arguments, no config', async () => {
    create.mockResolvedValue(fakeWorker());
    await startWorker(jest.fn(), jest.fn());
    await startWorker(jest.fn(), jest.fn(), {});
    for (const call of create.mock.calls) {
      expect(call).toHaveLength(3);
      expect(call.slice(0, 2)).toEqual(['eng', 1]);
    }
  });

  it('init goes to createWorker as its config (init-only params), and TESSERACT_PARAMS still go to setParameters', async () => {
    const worker = fakeWorker();
    create.mockResolvedValue(worker);
    const init = { load_system_dawg: '0', load_freq_dawg: '0' };
    await startWorker(jest.fn(), jest.fn(), init);
    expect(create.mock.calls[0]?.[3]).toEqual(init);
    expect(worker.setParameters.mock.calls).toEqual([[TESSERACT_PARAMS]]);
  });

  it('readLines without options is today\'s recognize call', async () => {
    const worker = fakeWorker();
    await readLines(worker as never, 'blob:a');
    await readLines(worker as never, 'blob:b', {});
    expect(worker.recognize.mock.calls).toEqual([
      ['blob:a', {}, { blocks: true }],
      ['blob:b', {}, { blocks: true }],
    ]);
    expect(worker.setParameters).not.toHaveBeenCalled();
  });

  it('a variant\'s params and rotateAuto go to this read\'s recognize options (restored by tesseract.js after it)', async () => {
    const worker = fakeWorker();
    await readLines(worker as never, 'blob:a', { params: { thresholding_method: '2', user_defined_dpi: '300' }, rotateAuto: true });
    expect(worker.recognize.mock.calls).toEqual([
      ['blob:a', { thresholding_method: '2', user_defined_dpi: '300', rotateAuto: true }, { blocks: true }],
    ]);
    // Not on the worker: nothing outlives the read.
    expect(worker.setParameters).not.toHaveBeenCalled();
  });

  it('rotateAuto false adds nothing', async () => {
    const worker = fakeWorker();
    await readLines(worker as never, 'blob:a', { rotateAuto: false });
    expect(worker.recognize.mock.calls[0]?.[1]).toEqual({});
  });

  it('onImageBinary asks for imageBinary and receives the data URL; the lines are unchanged', async () => {
    const worker = fakeWorker();
    worker.recognize.mockResolvedValue({ data: { ...PAGE, imageBinary: 'data:image/png;base64,AAAA' } });
    const got: string[] = [];
    const text = await readLines(worker as never, 'blob:a', { onImageBinary: (u) => got.push(u) });
    expect(worker.recognize.mock.calls[0]?.[2]).toEqual({ blocks: true, imageBinary: true });
    expect(got).toEqual(['data:image/png;base64,AAAA']);
    expect(text).toEqual(mapTesseractResult(PAGE as unknown as Page));
  });

  it('onImageBinary is not called when the engine returns no image', async () => {
    const worker = fakeWorker();
    const cb = jest.fn();
    await readLines(worker as never, 'blob:a', { onImageBinary: cb });
    expect(cb).not.toHaveBeenCalled();
  });

  it('reinitWorker re-inits with the new init (or {} for defaults) and re-applies TESSERACT_PARAMS', async () => {
    const worker = fakeWorker();
    await reinitWorker(worker as never, { load_system_dawg: '0' });
    await reinitWorker(worker as never, undefined);
    expect(worker.reinitialize.mock.calls).toEqual([
      ['eng', 1, { load_system_dawg: '0' }],
      ['eng', 1, {}],
    ]);
    expect(worker.setParameters.mock.calls).toEqual([[TESSERACT_PARAMS], [TESSERACT_PARAMS]]);
    expect(worker.reinitialize.mock.invocationCallOrder[0]!).toBeLessThan(worker.setParameters.mock.invocationCallOrder[0]!);
  });

  it('mapTesseractResult adds confidence only when it is a finite number in 0–100', () => {
    const box = { x0: 0, y0: 0, x1: 10, y1: 10 };
    const cases: [unknown, number | undefined][] = [
      [0, 0], [100, 100], [55.5, 55.5], [-1, undefined], [100.1, undefined], [Number.NaN, undefined],
      [Number.POSITIVE_INFINITY, undefined], ['80', undefined], [null, undefined], [undefined, undefined],
    ];
    for (const [confidence, want] of cases) {
      const [l] = mapTesseractResult({ blocks: [{ paragraphs: [{ lines: [{ text: 'a', bbox: box, confidence }] }] }] } as unknown as Page).lines;
      expect(l).toEqual(want === undefined ? { text: 'a', box: { x: 0, y: 0, width: 10, height: 10 } } : { text: 'a', box: { x: 0, y: 0, width: 10, height: 10 }, confidence: want });
      expect(l !== undefined && 'confidence' in l).toBe(want !== undefined);
    }
  });
});
