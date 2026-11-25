// Native scan entry (Jest's default platform). Spec: docs/specs/2026-11-22-web-opencv-preprocessing.md,
// Task 3, criterion 21: the stubs make today's prepare → recognize → parse calls, with one attempt.
import { getFixture } from './fixtures/receipts';
import { parseReceipt } from './receiptText';
import { RecognitionError } from './recognitionError';
import { createFakeRecognizer, type FakeRecognizer } from '../test-utils/fakeRecognizer';

const mockPrepare = jest.fn();
const mockDelete = jest.fn();
jest.mock('./prepareImage', () => ({
  prepareForRecognition: (uri: string) => mockPrepare(uri),
  deleteTempImages: (uris: unknown) => mockDelete(uris),
}));
let mockRecognizer: FakeRecognizer;
jest.mock('./recognizer', () => ({
  get recognizer() {
    return mockRecognizer;
  },
}));

import { scanReceipt } from './scanReceipt';
import { SHOW_FAILURE_SCREEN } from './scanPipeline/config';

const CAPTURED = 'file:///cache/photo.jpg';
const RESIZED = 'file:///cache/resized.jpg';

beforeEach(() => {
  jest.clearAllMocks();
  mockRecognizer = createFakeRecognizer({ result: getFixture('diner-simple').text });
  mockPrepare.mockResolvedValue({ uri: RESIZED, width: 1536, height: 2048 });
  mockDelete.mockResolvedValue(undefined);
});

describe('native scanReceipt (Platform ios) at the starting config', () => {
  it('prepare(captured) → recognize(resized, signal/onStage/onProgress) → parse, one attempt, temps deleted once', async () => {
    const signal = new AbortController().signal;
    const onStage = jest.fn();
    const onProgress = jest.fn();
    const r = await scanReceipt(CAPTURED, { signal, onStage, onProgress });
    expect(mockPrepare.mock.calls).toEqual([[CAPTURED]]);
    expect(mockRecognizer.calls).toEqual([RESIZED]);
    expect(mockRecognizer.options[0]?.signal).toBe(signal);
    expect(r.attempts).toHaveLength(1);
    expect(r.best.parsed).toEqual(parseReceipt(getFixture('diner-simple').text));
    expect(r.attempts[0]).toMatchObject({ variant: 'native-current', cropApplied: false, passes: 1 });
    expect(mockDelete.mock.calls).toEqual([[[CAPTURED, RESIZED]]]);
  });

  it('a recognizer error passes through as the same RecognitionError, and temps are still deleted', async () => {
    const err = new RecognitionError('failed', 'RECOGNITION_FAILED');
    mockRecognizer = createFakeRecognizer({ error: err });
    await expect(scanReceipt(CAPTURED)).rejects.toBe(err);
    expect(mockDelete.mock.calls).toEqual([[[CAPTURED, RESIZED]]]);
  });

  it('the failure screen is on for native (spec A1 Q6); the screen itself is Task 10', () => {
    expect(SHOW_FAILURE_SCREEN).toEqual({ web: true, native: true });
  });
});
