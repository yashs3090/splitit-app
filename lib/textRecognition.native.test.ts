import type { RecognitionResult } from 'expo-mlkit-ocr';

import { createFakeRecognizer } from '@/test-utils/fakeRecognizer';

import {
  mapOcrError,
  mapOcrResult,
  RecognitionError,
  resetLibraryCacheForTests,
  textRecognizer,
} from './textRecognition.native';

const mockRecognizeText = jest.fn<Promise<RecognitionResult>, [string]>();
const mockIsSupported = jest.fn<boolean, []>();

jest.mock('expo-mlkit-ocr', () => ({
  recognizeText: (uri: string) => mockRecognizeText(uri),
  isSupported: () => mockIsSupported(),
}));

const box = (x: number, y: number, width = 100, height = 20) => ({ x, y, width, height });

function line(text: string, b: ReturnType<typeof box>) {
  return { text, boundingBox: b, elements: [] };
}

const twoBlocks: RecognitionResult = {
  text: 'Burger\nFries\n12.99',
  blocks: [
    { text: 'Burger\nFries', boundingBox: box(10, 10, 200, 60), lines: [line('Burger', box(10, 10)), line('Fries', box(10, 50))] },
    { text: '12.99', boundingBox: box(400, 10), lines: [line('12.99', box(400, 10))] },
  ],
};

function codedError(code: string, message = 'Failed to load image from: /private/var/secret/path.jpg') {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  mockRecognizeText.mockReset();
  mockIsSupported.mockReset().mockReturnValue(true);
  resetLibraryCacheForTests();
});

describe('mapOcrResult', () => {
  it('flattens 2 blocks with 3 lines into 3 lines, in order, boxes preserved', () => {
    expect(mapOcrResult(twoBlocks)).toEqual({
      lines: [
        { text: 'Burger', box: box(10, 10) },
        { text: 'Fries', box: box(10, 50) },
        { text: '12.99', box: box(400, 10) },
      ],
    });
  });

  it('omits the box when the library has none (Android returns {} for a missing box)', () => {
    const result = {
      text: 'Soda',
      blocks: [{ text: 'Soda', boundingBox: box(0, 0), lines: [{ text: 'Soda', boundingBox: {}, elements: [] }] }],
    } as unknown as RecognitionResult; // test double: shape the library's types don't allow
    expect(mapOcrResult(result)).toEqual({ lines: [{ text: 'Soda' }] });
  });

  it('omits a box with a non-finite coordinate', () => {
    const result: RecognitionResult = {
      text: 'Tax',
      blocks: [{ text: 'Tax', boundingBox: box(0, 0), lines: [line('Tax', { x: NaN, y: 1, width: 2, height: 3 })] }],
    };
    expect(mapOcrResult(result).lines[0]).toEqual({ text: 'Tax' });
  });

  it('returns no lines for an empty result', () => {
    expect(mapOcrResult({ text: '', blocks: [] })).toEqual({ lines: [] });
  });
});

describe('mapOcrError', () => {
  it.each(['IMAGE_LOAD_FAILED', 'INVALID_URI'])('maps %s to image_load_failed', (code) => {
    const err = mapOcrError(codedError(code));
    expect(err).toBeInstanceOf(RecognitionError);
    expect(err.code).toBe('image_load_failed');
    expect(err.nativeCode).toBe(code);
  });

  it.each([codedError('RECOGNITION_FAILED'), codedError('NO_CONTEXT'), new Error('boom'), 'a string', null])(
    'maps any other rejection (%p) to failed',
    (e) => {
      expect(mapOcrError(e).code).toBe('failed');
    },
  );

  it("never carries the library's message (it can contain the file path)", () => {
    expect(mapOcrError(codedError('IMAGE_LOAD_FAILED')).message).not.toContain('/private');
  });
});

describe('textRecognizer (native)', () => {
  it('is available when the library loads and reports support', () => {
    expect(textRecognizer.isAvailable()).toBe(true);
  });

  it('is unavailable when the library reports no support or throws', () => {
    mockIsSupported.mockReturnValueOnce(false);
    expect(textRecognizer.isAvailable()).toBe(false);
    mockIsSupported.mockImplementationOnce(() => {
      throw new Error('native gone');
    });
    expect(textRecognizer.isAvailable()).toBe(false);
  });

  it('recognize passes the URI through and maps the result', async () => {
    mockRecognizeText.mockResolvedValueOnce(twoBlocks);
    await expect(textRecognizer.recognize('file:///cache/r.jpg')).resolves.toEqual(mapOcrResult(twoBlocks));
    expect(mockRecognizeText).toHaveBeenCalledWith('file:///cache/r.jpg');
  });

  it('recognize rejects with image_load_failed for a mocked IMAGE_LOAD_FAILED', async () => {
    mockRecognizeText.mockRejectedValueOnce(codedError('IMAGE_LOAD_FAILED'));
    await expect(textRecognizer.recognize('file:///x.jpg')).rejects.toMatchObject({
      name: 'RecognitionError',
      code: 'image_load_failed',
    });
  });

  it('recognize rejects with failed for any other rejection', async () => {
    mockRecognizeText.mockRejectedValueOnce(codedError('RECOGNITION_FAILED'));
    await expect(textRecognizer.recognize('file:///x.jpg')).rejects.toMatchObject({ code: 'failed' });
  });

  it('recognize rejects with failed when the result is malformed', async () => {
    mockRecognizeText.mockResolvedValueOnce({ text: '', blocks: [null] } as unknown as RecognitionResult); // test double
    await expect(textRecognizer.recognize('file:///x.jpg')).rejects.toMatchObject({ code: 'failed' });
  });
});

describe('createFakeRecognizer', () => {
  it('records calls and returns copies of the configured result', async () => {
    const fake = createFakeRecognizer({ result: { lines: [{ text: 'Burger 12.99' }] } });
    expect(fake.isAvailable()).toBe(true);
    const first = await fake.recognize('file:///a.jpg');
    first.lines.push({ text: 'mutated' });
    await expect(fake.recognize('file:///b.jpg')).resolves.toEqual({ lines: [{ text: 'Burger 12.99' }] });
    expect(fake.calls).toEqual(['file:///a.jpg', 'file:///b.jpg']);
    expect(fake.availabilityChecks).toBe(1);
  });

  it('can be unavailable and can reject', async () => {
    const fake = createFakeRecognizer({ available: false, error: new RecognitionError('failed') });
    expect(fake.isAvailable()).toBe(false);
    await expect(fake.recognize('file:///a.jpg')).rejects.toMatchObject({ code: 'failed' });
  });
});
