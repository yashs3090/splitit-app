// Fake TextRecognizer for tests (spec: docs/specs/2026-11-20-m1a-scan-receipt.md, Task 2; A3 options).
// No native module, no Tesseract and no device needed.
import type { RecognizedText } from '@/lib/receiptTypes';
import { RecognitionError } from '@/lib/recognitionError';
import type { RecognizeOptions, TextRecognizer } from '@/lib/textRecognition';

export type FakeRecognizerOptions = {
  /** Default true. */
  available?: boolean;
  /** What `recognize` resolves with. Default `{ lines: [] }`. Ignored when `error` is set. */
  result?: RecognizedText;
  /** If set, `recognize` rejects with this. */
  error?: unknown;
  /**
   * If true, `recognize` stays pending until the test calls `finish()` (resolve with `result` /
   * reject with `error`). Aborting the signal rejects it with `RecognitionError('cancelled')`,
   * like the web recognizer.
   */
  deferred?: boolean;
};

export type FakeRecognizer = TextRecognizer & {
  /** Every `recognize` call's image URI, in order. */
  readonly calls: string[];
  /** Every `recognize` call's options, in order. */
  readonly options: (RecognizeOptions | undefined)[];
  /** Number of `isAvailable` calls. */
  readonly availabilityChecks: number;
  /** Deferred mode: settle the oldest pending call. */
  finish(): void;
};

function copy(result: RecognizedText): RecognizedText {
  // A deep copy, so a test that mutates the result can't leak into the next call.
  // (RecognizedText is plain JSON, so a JSON round trip is an exact copy.)
  return JSON.parse(JSON.stringify(result)) as RecognizedText;
}

export function createFakeRecognizer(options: FakeRecognizerOptions = {}): FakeRecognizer {
  const { available = true, result = { lines: [] }, error, deferred = false } = options;
  const calls: string[] = [];
  const opts: (RecognizeOptions | undefined)[] = [];
  const pending: (() => void)[] = [];
  let availabilityChecks = 0;

  const settle = (resolve: (r: RecognizedText) => void, reject: (e: unknown) => void) => {
    if (error !== undefined) reject(error);
    else resolve(copy(result));
  };

  return {
    calls,
    options: opts,
    get availabilityChecks() {
      return availabilityChecks;
    },
    isAvailable() {
      availabilityChecks += 1;
      return available;
    },
    recognize(imageUri, o) {
      calls.push(imageUri);
      opts.push(o);
      if (!deferred) {
        return new Promise<RecognizedText>(settle);
      }
      return new Promise<RecognizedText>((resolve, reject) => {
        let done = false;
        o?.signal?.addEventListener('abort', () => {
          if (done) return;
          done = true;
          reject(new RecognitionError('cancelled'));
        });
        pending.push(() => {
          if (done) return;
          done = true;
          settle(resolve, reject);
        });
      });
    },
    finish() {
      pending.shift()?.();
    },
  };
}
