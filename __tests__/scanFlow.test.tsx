// Scan flow: criteria 37–43 (Task 7) and 57–58 (A3 / Task 9) in docs/specs/2026-11-20-m1a-scan-receipt.md,
// and criteria 46–53 (Task 10: progress copy and the failure screen) in
// docs/specs/2026-11-22-web-opencv-preprocessing.md.
// Capture is mocked at `@/lib/capturePhoto`; its permission/camera logic is tested in lib/capturePhoto.*.test.ts.
import { router as globalRouter } from 'expo-router';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { Linking, Platform } from 'react-native';

import { MISMATCH_BANNER } from '@/components/BillForm';
import { REASON_COPY } from '@/lib/billDraft';
import { getFixture, linesOf } from '@/lib/fixtures/receipts';
import { deleteTempImages, prepareForRecognition } from '@/lib/prepareImage';
import { RecognitionError } from '@/lib/recognitionError';
import { parseReceipt } from '@/lib/receiptText';
import { assessQuality } from '@/lib/scanPipeline/assessQuality';
import { CV_LOADED_KEY } from '@/lib/scanScreen';
import { clearScanResult, getScanResult } from '@/lib/scanSession';
import { storage } from '@/lib/storage';
import { supabase as realSupabase } from '@/lib/supabase';
import { createFakeRecognizer, type FakeRecognizer } from '@/test-utils/fakeRecognizer';
import { fakeSession, type FakeSupabase } from '@/test-utils/fakes';
import { capturePhoto, type CaptureResult } from '@/lib/capturePhoto';

jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
jest.mock('@/lib/storage', () => {
  const { createMemoryStorage } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { storage: createMemoryStorage() };
});

let mockRecognizer: FakeRecognizer;
jest.mock('@/lib/recognizer', () => ({
  get recognizer() {
    return mockRecognizer;
  },
}));
// The platform labels, switchable per test (native by default). The native manual label changed from
// "Type it instead" to "Enter items" in the scan screen redesign (spec 2026-11-25).
const mockLabels = { capture: 'Take photo', manual: 'Enter items' };
jest.mock('@/lib/capturePhoto', () => ({
  capturePhoto: jest.fn(),
  get CAPTURE_LABEL() {
    return mockLabels.capture;
  },
  get MANUAL_ENTRY_LABEL() {
    return mockLabels.manual;
  },
}));
// The pipeline config, switchable per test. Defaults are the real values.
const mockConfig: {
  nativePlan: { primary: string; retry: string | null } | null;
  webPlan: { primary: string; retry: string | null } | null;
  showFailure: { web: boolean; native: boolean } | null;
  cv: boolean | null;
} = { nativePlan: null, webPlan: null, showFailure: null, cv: null };
jest.mock('@/lib/scanPipeline/config', () => {
  const actual = jest.requireActual<typeof import('@/lib/scanPipeline/config')>('@/lib/scanPipeline/config');
  // defineProperties, not `{ ...actual, get X() {} }`: Babel's object-spread helper reads a getter
  // once, when the object is built, so per-test changes would be ignored.
  return Object.defineProperties(
    { ...actual },
    {
      PIPELINE: {
        enumerable: true,
        get: () => ({ web: mockConfig.webPlan ?? actual.PIPELINE.web, native: mockConfig.nativePlan ?? actual.PIPELINE.native }),
      },
      SHOW_FAILURE_SCREEN: { enumerable: true, get: () => mockConfig.showFailure ?? actual.SHOW_FAILURE_SCREEN },
      WEB_CV_PREPROCESS: { enumerable: true, get: () => mockConfig.cv ?? actual.WEB_CV_PREPROCESS },
    },
  ) as typeof actual;
});
// The real pipeline entry by default; a test can replace one scan's result (R4 needs a trace with an
// OpenCV fallback, which the native pipeline that Jest resolves never produces).
let mockScanOverride: ((...args: unknown[]) => Promise<unknown>) | null = null;
jest.mock('@/lib/scanReceipt', () => {
  const actual = jest.requireActual<typeof import('@/lib/scanReceipt')>('@/lib/scanReceipt');
  return {
    ...actual,
    scanReceipt: (...args: Parameters<typeof actual.scanReceipt>) => {
      const override = mockScanOverride;
      mockScanOverride = null;
      return override ? override(...args) : actual.scanReceipt(...args);
    },
  };
});
jest.mock('@/lib/prepareImage', () => ({
  prepareForRecognition: jest.fn(),
  deleteTempImages: jest.fn(),
}));

const supabase = realSupabase as unknown as FakeSupabase;
const capture = capturePhoto as jest.Mock<Promise<CaptureResult>, []>;
const prepare = prepareForRecognition as jest.Mock;
const deleteTemps = deleteTempImages as jest.Mock;

const CAPTURED = 'file:///app/Library/Caches/ImagePicker/photo.jpg';
const RESIZED = 'file:///app/Library/Caches/ImageManipulator/resized.jpg';
const READ_FAILED =
  "Couldn't read that photo. Try again with the receipt flat and well lit, or enter the items yourself.";
const ASK = 'SplitIt needs the camera to read your receipt.';
const BLOCKED = 'Camera access is off for SplitIt. Turn it on in Settings.';
const UNAVAILABLE = 'Scanning works in the iPhone app. You can enter the items yourself.';
// Task 10 failure screen copy (spec 2026-11-22, fixed app copy).
const UNCLEAR = "We couldn't read this receipt clearly.";
const NO_ITEMS = 'We found no items.';
const NO_TOTAL = "We couldn't find the total.";
const GAP = "The items don't add up to the total.";
const TIP = 'Lay it flat in good light and fill the frame.';
// Hand-made reads with 5+ lines (MIN_LINES), each with exactly one problem.
const NO_TOTAL_READ = linesOf('Corner Cafe', 'Bagel 3.50', 'Coffee 2.75', 'Subtotal 6.25', 'Tax 0.50');
const NO_TOTAL_ITEMS = ['Bagel', 'Coffee'];
const NO_ITEMS_READ = linesOf('Corner Cafe', '12 Main St', 'Thank you', 'Come again', 'Have a nice day');

function captureReturns(result: CaptureResult) {
  capture.mockResolvedValue(result);
}
function useWebLabels() {
  mockLabels.capture = 'Take or upload photo';
  mockLabels.manual = 'Enter items';
}

async function openScan() {
  const router = renderRouter('./app', { initialUrl: '/scan' });
  await screen.findByText('Scan receipt');
  return router;
}

async function press(text: string) {
  await act(async () => {
    fireEvent.press(screen.getByText(text));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  clearScanResult();
  supabase.__setInitialSession(fakeSession());
  mockRecognizer = createFakeRecognizer({ available: true, result: getFixture('diner-simple').text });
  mockLabels.capture = 'Take photo';
  mockLabels.manual = 'Enter items';
  captureReturns({ kind: 'photo', uri: CAPTURED });
  prepare.mockResolvedValue({ uri: RESIZED, width: 1536, height: 2048 });
  deleteTemps.mockResolvedValue(undefined);
  mockConfig.nativePlan = null;
  mockConfig.webPlan = null;
  mockConfig.showFailure = null;
  mockConfig.cv = null;
  mockScanOverride = null;
});

describe('scan flow', () => {
  it('37: granted → camera → recognize → /bill prefilled, temp files deleted, nothing in the URL', async () => {
    const router = await openScan();
    await press('Take photo');

    expect(await screen.findByText('Check the items')).toBeTruthy();
    expect(router.getPathname()).toBe('/bill');
    expect(router.getSearchParams()).toEqual({});
    expect(prepare).toHaveBeenCalledWith(CAPTURED);
    expect(mockRecognizer.calls).toEqual([RESIZED]);
    for (const name of ['Cheeseburger', 'Caesar Salad', 'Iced Tea']) {
      expect(screen.getByDisplayValue(name)).toBeTruthy();
    }
    for (const price of ['12.99', '9.50', '3.25']) {
      expect(screen.getByDisplayValue(price)).toBeTruthy();
    }
    expect(screen.queryByText(MISMATCH_BANNER)).toBeNull();
    expect(deleteTemps).toHaveBeenCalledTimes(1);
    expect(deleteTemps).toHaveBeenCalledWith([CAPTURED, RESIZED]);
  });

  it('38a: permission "ask" explains and offers Try again; the camera is not launched', async () => {
    captureReturns({ kind: 'permission', state: 'ask' });
    await openScan();
    await press('Take photo');

    expect(screen.getByText(ASK)).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
    expect(screen.queryByText('Open Settings')).toBeNull();
    expect(prepare).not.toHaveBeenCalled();

    // Try again asks again; granting this time takes the photo.
    captureReturns({ kind: 'photo', uri: CAPTURED });
    await press('Try again');
    expect(capture).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Check the items')).toBeTruthy();
  });

  it('38b: permission "blocked" offers Open Settings, which calls Linking.openSettings once', async () => {
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    try {
      captureReturns({ kind: 'permission', state: 'blocked' });
      await openScan();
      await press('Take photo');

      expect(screen.getByText(BLOCKED)).toBeTruthy();
      await press('Open Settings');
      expect(openSettings).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      openSettings.mockRestore();
    }
  });

  it('39: camera cancelled stays on /scan with no error and no recognition', async () => {
    captureReturns({ kind: 'cancelled' });
    const router = await openScan();
    await press('Take photo');

    expect(router.getPathname()).toBe('/scan');
    expect(screen.getByText('Take photo')).toBeTruthy();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(prepare).not.toHaveBeenCalled();
    expect(mockRecognizer.calls).toEqual([]);
    expect(deleteTemps).not.toHaveBeenCalled();
  });

  it('40a: a recognizer error shows fixed copy only, still deletes temp files, and Enter items opens the empty form', async () => {
    const secret = 'native failure at /private/var/mobile/photo.jpg';
    const error = new RecognitionError('failed', 'RECOGNITION_FAILED');
    error.message = secret;
    mockRecognizer = createFakeRecognizer({ available: true, error });
    const router = await openScan();
    await press('Take photo');

    expect(await screen.findByText(READ_FAILED)).toBeTruthy();
    expect(screen.queryByText(new RegExp(secret.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')))).toBeNull();
    expect(screen.queryByText(/RECOGNITION_FAILED|Text recognition failed/)).toBeNull();
    expect(router.getPathname()).toBe('/scan');
    expect(getScanResult()).toBeNull();
    expect(deleteTemps).toHaveBeenCalledWith([CAPTURED, RESIZED]);

    await press('Enter items');
    expect(await screen.findByText('Enter the items')).toBeTruthy();
    expect(screen.queryByLabelText('Item 1 name')).toBeNull();
    expect(router.getPathname()).toBe('/bill');
  });

  // Changed in Task 10 (spec 2026-11-22): with the failure screen on (A1 Q6), zero lines now shows
  // "We found no items." on the failure screen instead of READ_FAILED. The old behaviour is kept
  // with the screen off (criterion 52, below).
  it('40b: zero recognized lines shows the failure screen ("We found no items.") and deletes temp files', async () => {
    mockRecognizer = createFakeRecognizer({ available: true, result: { lines: [] } });
    const router = await openScan();
    await press('Take photo');

    expect(await screen.findByText(UNCLEAR)).toBeTruthy();
    expect(screen.getByText(NO_ITEMS)).toBeTruthy();
    expect(screen.queryByText(READ_FAILED)).toBeNull();
    expect(router.getPathname()).toBe('/scan');
    expect(getScanResult()).toBeNull();
    expect(deleteTemps).toHaveBeenCalledWith([CAPTURED, RESIZED]);
  });

  it('40c: a resize failure shows the fixed copy and deletes the captured photo', async () => {
    prepare.mockRejectedValue(new RecognitionError('image_load_failed', 'PREPARE_FAILED'));
    await openScan();
    await press('Take photo');

    expect(await screen.findByText(READ_FAILED)).toBeTruthy();
    expect(mockRecognizer.calls).toEqual([]);
    expect(deleteTemps).toHaveBeenCalledWith([CAPTURED, undefined]);
  });

  it('a camera permission error shows fixed copy, not the error text', async () => {
    capture.mockRejectedValue(new Error('E_MISSING_PERMISSION internal detail'));
    await openScan();
    await press('Take photo');

    expect(screen.getByText("Couldn't open the camera. Try again, or enter the items yourself.")).toBeTruthy();
    expect(screen.queryByText(/E_MISSING_PERMISSION|internal detail/)).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('41: recognizer unavailable shows the web copy, no Take photo, no permission request; Enter items opens the empty form', async () => {
    mockRecognizer = createFakeRecognizer({ available: false });
    const router = await openScan();

    expect(screen.getByText(UNAVAILABLE)).toBeTruthy();
    expect(screen.queryByText('Take photo')).toBeNull();
    expect(screen.queryByText('Take or upload photo')).toBeNull();
    expect(capture).not.toHaveBeenCalled();

    await press('Enter items');
    expect(await screen.findByText('Enter the items')).toBeTruthy();
    expect(router.getPathname()).toBe('/bill');
  });

  it('41 (web): with Platform.OS = web the unavailable branch renders the same way', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'web');
    try {
      mockRecognizer = createFakeRecognizer({ available: false });
      await openScan();
      expect(screen.getByText(UNAVAILABLE)).toBeTruthy();
      expect(screen.queryByText('Take photo')).toBeNull();
      expect(capture).not.toHaveBeenCalled();
    } finally {
      os.restore();
    }
  });

  // Changed in Task 10 (spec 2026-11-22): a 2¢-off read now stops on the failure screen first; "Type it in"
  // then lands on /bill with the red banner, as the old test asserted directly (criterion 49).
  it('42: a 2¢-off scan shows the failure screen; Type it in lands on /bill pre-filled with the red banner', async () => {
    mockRecognizer = createFakeRecognizer({ available: true, result: getFixture('does-not-add-up').text });
    const router = await openScan();
    await press('Take photo');

    expect(await screen.findByText(UNCLEAR)).toBeTruthy();
    expect(screen.getByText(GAP)).toBeTruthy();
    expect(router.getPathname()).toBe('/scan');
    expect(getScanResult()).toBeNull();

    await press('Type it in');
    expect(await screen.findByText('Check the items')).toBeTruthy();
    expect(getScanResult()).not.toBeNull();
    expect(router.getSearchParams()).toEqual({});
    expect(router.getPathname()).toBe('/bill');
    expect(screen.getByText(MISMATCH_BANNER)).toBeTruthy();
    expect(screen.getByText(REASON_COPY.items_vs_subtotal)).toBeTruthy();
  });

  it('43: after a scan, Enter items (back on /scan) clears the old result', async () => {
    const router = await openScan();
    await press('Take photo');
    expect(await screen.findByText('Check the items')).toBeTruthy();
    expect(getScanResult()).not.toBeNull();

    await act(async () => {
      globalRouter.back();
    });
    await waitFor(() => expect(router.getPathname()).toBe('/scan'));

    await press('Enter items');
    expect(await screen.findByText('Enter the items')).toBeTruthy();
    expect(getScanResult()).toBeNull();
    expect(screen.queryByDisplayValue('Cheeseburger')).toBeNull();
    expect(router.getPathname()).toBe('/bill');
    expect(router.getSearchParams()).toEqual({});
  });

  describe('web scanning (A3)', () => {
    const LOAD_FAILED =
      "Couldn't load the text reader. Check your connection and try again, or enter the items yourself.";
    // Changed in Task 10 (spec 2026-11-22): the timeout uses the failure screen's layout, so its copy is
    // now the banner title "Reading took too long." with "Retake photo" / "Type it in" buttons
    // (was "Reading took too long. Try again, or type it in." with "Try again" / "Enter items").
    const TIMED_OUT = 'Reading took too long.';

    it('web labels: shows Take or upload photo and Enter items, not the "iPhone app" text', async () => {
      const os = jest.replaceProperty(Platform, 'OS', 'web');
      try {
        useWebLabels();
        const router = await openScan();
        expect(screen.getByText('Take or upload photo')).toBeTruthy();
        expect(screen.getByText('Enter items')).toBeTruthy();
        expect(screen.queryByText(UNAVAILABLE)).toBeNull();

        await press('Take or upload photo');
        expect(await screen.findByText('Check the items')).toBeTruthy();
        expect(router.getPathname()).toBe('/bill');
        expect(router.getSearchParams()).toEqual({});
        expect(deleteTemps).toHaveBeenCalledWith([CAPTURED, RESIZED]);
      } finally {
        os.restore();
      }
    });

    it('57: shows Reading receipt… and a progress bar that follows onProgress; Cancel aborts and returns to idle', async () => {
      mockRecognizer = createFakeRecognizer({ available: true, deferred: true, result: getFixture('diner-simple').text });
      const router = await openScan();
      await press('Take photo');

      expect(screen.getByText('Reading receipt…')).toBeTruthy();
      expect(screen.getByText('Cancel')).toBeTruthy();
      const opts = mockRecognizer.options[0];
      expect(opts?.signal).toBeDefined();

      await act(async () => {
        opts?.onStage?.('recognizing');
        opts?.onProgress?.(0.4);
      });
      expect(screen.getByRole('progressbar').props.accessibilityValue).toEqual({ min: 0, max: 100, now: 40 });
      await act(async () => {
        opts?.onProgress?.(0.75);
      });
      expect(screen.getByRole('progressbar').props.accessibilityValue).toMatchObject({ now: 75 });

      await press('Cancel');
      expect(opts?.signal?.aborted).toBe(true);
      expect(screen.getByText('Take photo')).toBeTruthy();
      expect(screen.queryByText('Reading receipt…')).toBeNull();
      expect(screen.queryAllByRole('alert')).toHaveLength(0);
      expect(router.getPathname()).toBe('/scan');
      expect(getScanResult()).toBeNull();
      await waitFor(() => expect(deleteTemps).toHaveBeenCalledWith([CAPTURED, RESIZED]));
      expect(screen.queryAllByRole('alert')).toHaveLength(0);
    });

    it('57: a result arriving after Cancel is ignored, and a new scan can start right away', async () => {
      // A recognizer that ignores the signal (like native): the late result must not navigate.
      let finishFirst: (() => void) | undefined;
      const fixture = getFixture('diner-simple').text;
      let n = 0;
      mockRecognizer = createFakeRecognizer({ available: true, result: fixture });
      const base = mockRecognizer.recognize.bind(mockRecognizer);
      mockRecognizer.recognize = (uri, o) => {
        n += 1;
        if (n === 1) {
          return new Promise((resolve) => {
            finishFirst = () => resolve(fixture);
          });
        }
        return base(uri, o);
      };
      const router = await openScan();
      await press('Take photo');
      await press('Cancel');
      await act(async () => {
        finishFirst?.();
      });
      expect(router.getPathname()).toBe('/scan');
      expect(getScanResult()).toBeNull();
      expect(screen.getByText('Take photo')).toBeTruthy();

      await press('Take photo');
      expect(await screen.findByText('Check the items')).toBeTruthy();
      expect(n).toBe(2);
    });

    it('shows "Getting the text reader ready…" while the engine loads', async () => {
      mockRecognizer = createFakeRecognizer({ available: true, deferred: true });
      await openScan();
      await press('Take photo');
      await act(async () => {
        mockRecognizer.options[0]?.onStage?.('loading_engine');
      });
      expect(screen.getByText('Getting the text reader ready…')).toBeTruthy();
      expect(screen.queryByRole('progressbar')).toBeNull();
      await act(async () => {
        mockRecognizer.options[0]?.onStage?.('recognizing');
      });
      expect(screen.getByText('Reading receipt…')).toBeTruthy();
      await press('Cancel');
    });

    it('58: engine_load_failed shows the "Couldn\'t load the text reader" copy, never the message; Enter items opens the empty form', async () => {
      useWebLabels();
      const error = new RecognitionError('engine_load_failed', 'WORKER_START_FAILED');
      error.message = 'GET https://example.test/tesseract/lang 404';
      mockRecognizer = createFakeRecognizer({ available: true, error });
      const router = await openScan();
      await press('Take or upload photo');

      expect(await screen.findByText(LOAD_FAILED)).toBeTruthy();
      expect(screen.queryByText(READ_FAILED)).toBeNull();
      expect(screen.queryByText(/404|example\.test|WORKER_START_FAILED|could not be loaded/)).toBeNull();
      expect(deleteTemps).toHaveBeenCalledWith([CAPTURED, RESIZED]);

      await press('Enter items');
      expect(await screen.findByText('Enter the items')).toBeTruthy();
      expect(screen.queryByLabelText('Item 1 name')).toBeNull();
      expect(router.getPathname()).toBe('/bill');
    });

    it.each(['failed', 'image_load_failed', 'unavailable'] as const)('58: %s shows the "Couldn\'t read that photo" copy', async (code) => {
      const error = new RecognitionError(code, 'X');
      error.message = 'secret detail /private/x';
      mockRecognizer = createFakeRecognizer({ available: true, error });
      await openScan();
      await press('Take photo');
      expect(await screen.findByText(READ_FAILED)).toBeTruthy();
      expect(screen.queryByText(LOAD_FAILED)).toBeNull();
      expect(screen.queryByText(/secret detail/)).toBeNull();
    });

    it('timeout (web recognize stalled) shows the fixed "took too long" copy, frees the photo and leaves the screen usable', async () => {
      useWebLabels();
      const error = new RecognitionError('timeout', 'RECOGNIZE_TIMEOUT');
      error.message = 'worker stalled at blob:https://example.test/abc';
      mockRecognizer = createFakeRecognizer({ available: true, error });
      const router = await openScan();
      await press('Take or upload photo');

      expect(await screen.findByText(TIMED_OUT)).toBeTruthy();
      expect(screen.queryByText(READ_FAILED)).toBeNull();
      expect(screen.queryByText(/stalled|example\.test|RECOGNIZE_TIMEOUT/)).toBeNull();
      expect(screen.queryByText('Text recognition took too long.')).toBeNull();
      expect(screen.queryByText('Reading receipt…')).toBeNull();
      expect(screen.queryByText('Cancel')).toBeNull();
      expect(deleteTemps).toHaveBeenCalledWith([CAPTURED, RESIZED]);
      expect(getScanResult()).toBeNull();
      expect(router.getPathname()).toBe('/scan');

      expect(screen.getByText(TIP)).toBeTruthy();
      expect(screen.queryByText(UNCLEAR)).toBeNull();

      // Retake photo (was "Try again") starts a fresh scan; a good read then opens the form.
      mockRecognizer = createFakeRecognizer({ available: true, result: getFixture('diner-simple').text });
      await press('Retake photo');
      expect(await screen.findByText('Check the items')).toBeTruthy();
      expect(router.getPathname()).toBe('/bill');
    });

    it('timeout: "Type it in" (was "Enter items") opens the empty form', async () => {
      useWebLabels();
      mockRecognizer = createFakeRecognizer({ available: true, error: new RecognitionError('timeout') });
      const router = await openScan();
      await press('Take or upload photo');
      expect(await screen.findByText(TIMED_OUT)).toBeTruthy();
      await press('Type it in');
      expect(await screen.findByText('Enter the items')).toBeTruthy();
      expect(router.getPathname()).toBe('/bill');
    });

    it('N1 (web): a picker that never settles (no cancel event) does not leave the button dead', async () => {
      const os = jest.replaceProperty(Platform, 'OS', 'web');
      try {
        useWebLabels();
        let settleFirst: ((r: CaptureResult) => void) | undefined;
        capture.mockImplementationOnce(
          () =>
            new Promise<CaptureResult>((resolve) => {
              settleFirst = resolve;
            }),
        );
        const router = await openScan();
        await press('Take or upload photo'); // the user dismisses the picker; nothing settles
        await press('Take or upload photo');
        expect(capture).toHaveBeenCalledTimes(2);
        expect(await screen.findByText('Check the items')).toBeTruthy();
        expect(router.getPathname()).toBe('/bill');
        expect(mockRecognizer.calls).toEqual([RESIZED]);

        // If the stale picker settles later, it is ignored and its photo is cleaned up.
        deleteTemps.mockClear();
        await act(async () => {
          settleFirst?.({ kind: 'photo', uri: 'blob:stale' });
        });
        expect(deleteTemps).toHaveBeenCalledWith(['blob:stale']);
        expect(mockRecognizer.calls).toEqual([RESIZED]);
        expect(router.getPathname()).toBe('/bill');
      } finally {
        os.restore();
      }
    });

    it('N1 (native): a second press while the camera is open is still ignored', async () => {
      capture.mockImplementationOnce(() => new Promise<CaptureResult>(() => {}));
      await openScan();
      await press('Take photo');
      await press('Take photo');
      expect(capture).toHaveBeenCalledTimes(1);
    });

    it('58: a recognizer that rejects with cancelled returns to idle with no error', async () => {
      mockRecognizer = createFakeRecognizer({ available: true, error: new RecognitionError('cancelled') });
      await openScan();
      await press('Take photo');
      await waitFor(() => expect(screen.getByText('Take photo')).toBeTruthy());
      expect(screen.queryAllByRole('alert')).toHaveLength(0);
    });
  });

  describe('failure screen and progress copy (spec 2026-11-22 Task 10)', () => {
    it('47: each problem kind shows its allow-listed line, plus the tip and both buttons', async () => {
      const cases: [string, Parameters<typeof createFakeRecognizer>[0], string][] = [
        ['no_total', { result: NO_TOTAL_READ }, NO_TOTAL],
        ['gap', { result: getFixture('does-not-add-up').text }, GAP],
        ['no_items', { result: NO_ITEMS_READ }, NO_ITEMS],
        ['too_few_lines', { result: linesOf('Corner Cafe', 'Thank you') }, NO_ITEMS],
      ];
      for (const [, opts, line] of cases) {
        mockRecognizer = createFakeRecognizer({ available: true, ...opts });
        const router = await openScan();
        await press('Take photo');
        expect(await screen.findByText(UNCLEAR)).toBeTruthy();
        expect(screen.getByText(line)).toBeTruthy();
        for (const other of [NO_ITEMS, NO_TOTAL, GAP].filter((l) => l !== line)) {
          expect(screen.queryByText(other)).toBeNull();
        }
        expect(screen.getByText(TIP)).toBeTruthy();
        expect(screen.getByText('Retake photo')).toBeTruthy();
        expect(screen.getByText('Type it in')).toBeTruthy();
        expect(router.getPathname()).toBe('/scan');
        screen.unmount();
      }
    });

    it('48: Retake photo clears the scan result and starts capture again', async () => {
      mockRecognizer = createFakeRecognizer({ available: true, result: NO_TOTAL_READ });
      const router = await openScan();
      await press('Take photo');
      expect(await screen.findByText(NO_TOTAL)).toBeTruthy();
      expect(capture).toHaveBeenCalledTimes(1);

      mockRecognizer = createFakeRecognizer({ available: true, result: getFixture('diner-simple').text });
      await press('Retake photo');
      expect(capture).toHaveBeenCalledTimes(2);
      expect(await screen.findByText('Check the items')).toBeTruthy();
      expect(router.getPathname()).toBe('/bill');
      expect(screen.getByDisplayValue('Cheeseburger')).toBeTruthy();
    });

    it('48: Retake photo with the camera cancelled returns to the idle screen with nothing stored', async () => {
      mockRecognizer = createFakeRecognizer({ available: true, result: NO_TOTAL_READ });
      await openScan();
      await press('Take photo');
      expect(await screen.findByText(NO_TOTAL)).toBeTruthy();
      captureReturns({ kind: 'cancelled' });
      await press('Retake photo');
      expect(await screen.findByText('Take photo')).toBeTruthy();
      expect(screen.queryByText(UNCLEAR)).toBeNull();
      expect(getScanResult()).toBeNull();
    });

    it('49: Type it in stores what was read and the form shows the read items (nothing lost)', async () => {
      mockRecognizer = createFakeRecognizer({ available: true, result: NO_TOTAL_READ });
      const router = await openScan();
      await press('Take photo');
      expect(await screen.findByText(NO_TOTAL)).toBeTruthy();

      await press('Type it in');
      expect(await screen.findByText('Check the items')).toBeTruthy();
      expect(router.getPathname()).toBe('/bill');
      expect(router.getSearchParams()).toEqual({});
      expect(getScanResult()?.items.map((i) => i.name)).toEqual(NO_TOTAL_ITEMS);
      for (const name of NO_TOTAL_ITEMS) expect(screen.getByDisplayValue(name)).toBeTruthy();
      for (const price of ['3.50', '2.75']) expect(screen.getByDisplayValue(price)).toBeTruthy();
    });

    it('50: both buttons have a label and a hint (native and web)', async () => {
      mockRecognizer = createFakeRecognizer({ available: true, result: NO_TOTAL_READ });
      await openScan();
      await press('Take photo');
      expect(await screen.findByText(NO_TOTAL)).toBeTruthy();
      const retake = screen.getByRole('button', { name: 'Retake photo' });
      const typeIn = screen.getByRole('button', { name: 'Type it in' });
      expect(retake.props.accessibilityHint).toBe('Opens the camera so you can take a new photo.');
      expect(typeIn.props.accessibilityHint).toBe('Opens the bill form with what was read filled in, so you can fix it.');
      screen.unmount();

      const os = jest.replaceProperty(Platform, 'OS', 'web');
      try {
        useWebLabels();
        await openScan();
        await press('Take or upload photo');
        expect(await screen.findByText(NO_TOTAL)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Retake photo' }).props.accessibilityHint).toBe(
          'Opens the photo picker so you can choose a new photo.',
        );
      } finally {
        os.restore();
      }
    });

    it('51: an error whose message is library text never renders it', async () => {
      const error = new RecognitionError('failed');
      error.message = 'SECRET-LIB-TEXT';
      mockRecognizer = createFakeRecognizer({ available: true, error });
      await openScan();
      await press('Take photo');
      expect(await screen.findByText(READ_FAILED)).toBeTruthy();
      expect(screen.queryByText(/SECRET-LIB-TEXT/)).toBeNull();

      const timeout = new RecognitionError('timeout');
      timeout.message = 'SECRET-LIB-TEXT';
      mockRecognizer = createFakeRecognizer({ available: true, error: timeout });
      await press('Try again');
      expect(await screen.findByText('Reading took too long.')).toBeTruthy();
      expect(screen.queryByText(/SECRET-LIB-TEXT/)).toBeNull();
    });

    it('52: with SHOW_FAILURE_SCREEN.native off, a native read that is not ok goes to /bill as before (Platform ios)', async () => {
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      try {
        mockConfig.showFailure = { web: true, native: false };
        mockRecognizer = createFakeRecognizer({ available: true, result: getFixture('does-not-add-up').text });
        const router = await openScan();
        await press('Take photo');
        expect(await screen.findByText('Check the items')).toBeTruthy();
        expect(router.getPathname()).toBe('/bill');
        expect(screen.getByText(MISMATCH_BANNER)).toBeTruthy();
        expect(screen.getByText(REASON_COPY.items_vs_subtotal)).toBeTruthy();
        expect(screen.queryByText(UNCLEAR)).toBeNull();
      } finally {
        os.restore();
      }
    });

    it('52: with the screen off, zero lines still shows "Couldn\'t read that photo" (today\'s behaviour)', async () => {
      mockConfig.showFailure = { web: false, native: false };
      mockRecognizer = createFakeRecognizer({ available: true, result: { lines: [] } });
      const router = await openScan();
      await press('Take photo');
      expect(await screen.findByText(READ_FAILED)).toBeTruthy();
      expect(screen.queryByText(UNCLEAR)).toBeNull();
      expect(router.getPathname()).toBe('/scan');
    });

    it('46: preparing, reading and retrying each show their copy in a polite live region; the retry ends on the failure screen', async () => {
      // A plan with an automatic retry, so the pipeline reports `retrying`.
      mockConfig.nativePlan = { primary: 'native-current', retry: 'native-current' };
      let releasePrepare: (() => void) | undefined;
      prepare.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releasePrepare = () => resolve({ uri: RESIZED, width: 1536, height: 2048 });
          }),
      );
      mockRecognizer = createFakeRecognizer({ available: true, deferred: true, result: getFixture('does-not-add-up').text });
      await openScan();
      await press('Take photo');

      const preparing = await screen.findByText('Preparing photo…');
      expect(preparing.props.accessibilityLiveRegion).toBe('polite');

      await act(async () => {
        releasePrepare?.();
      });
      expect(await screen.findByText('Reading receipt…')).toBeTruthy();
      await act(async () => {
        mockRecognizer.options[0]?.onProgress?.(1);
      });
      expect(screen.getByRole('progressbar').props.accessibilityValue).toMatchObject({ now: 100 });

      // The primary read doesn't add up, so the pipeline tries again.
      await act(async () => {
        mockRecognizer.finish();
      });
      const retrying = await screen.findByText('Taking a closer look…');
      expect(retrying.props.accessibilityLiveRegion).toBe('polite');
      // The last read's bar doesn't carry over into the retry.
      expect(screen.queryByRole('progressbar')).toBeNull();
      await act(async () => {
        mockRecognizer.options[1]?.onProgress?.(0.5);
      });
      expect(screen.getByRole('progressbar').props.accessibilityValue).toMatchObject({ now: 50 });

      await act(async () => {
        mockRecognizer.finish();
      });
      expect(await screen.findByText(UNCLEAR)).toBeTruthy();
      expect(screen.getByText(GAP)).toBeTruthy();
      expect(mockRecognizer.calls).toHaveLength(2);
    });

    it('23/46: Cancel during the retry returns to idle with nothing stored', async () => {
      mockConfig.nativePlan = { primary: 'native-current', retry: 'native-current' };
      mockRecognizer = createFakeRecognizer({ available: true, deferred: true, result: getFixture('does-not-add-up').text });
      const router = await openScan();
      await press('Take photo');
      await act(async () => {
        mockRecognizer.finish();
      });
      expect(await screen.findByText('Taking a closer look…')).toBeTruthy();
      await press('Cancel');
      expect(mockRecognizer.options[1]?.signal?.aborted).toBe(true);
      expect(screen.getByText('Take photo')).toBeTruthy();
      expect(screen.queryByText(UNCLEAR)).toBeNull();
      expect(getScanResult()).toBeNull();
      expect(router.getPathname()).toBe('/scan');
      await waitFor(() => expect(deleteTemps).toHaveBeenCalled());
    });

    const TIMED_OUT_COPY = 'Reading took too long.';
    /** The first read returns `first`; every later read rejects with a timeout (R1). */
    function timeoutAfterFirstRead(first: ReturnType<typeof linesOf>) {
      const base = createFakeRecognizer({ available: true, result: first });
      const timeoutErr = new RecognitionError('timeout', 'RECOGNIZE_TIMEOUT');
      timeoutErr.message = 'worker stalled SECRET-LIB-TEXT';
      const firstRead = base.recognize.bind(base);
      return Object.assign(base, {
        recognize: (uri: string, o?: Parameters<FakeRecognizer['recognize']>[1]) => {
          if (base.calls.length === 0) return firstRead(uri, o);
          base.calls.push(uri);
          return Promise.reject(timeoutErr);
        },
      });
    }

    it('23 (R1): a timeout during the retry keeps the first read: the failure screen shows it, and Type it in pre-fills it', async () => {
      mockConfig.nativePlan = { primary: 'native-current', retry: 'native-current' };
      mockRecognizer = timeoutAfterFirstRead(NO_TOTAL_READ);
      const router = await openScan();
      await press('Take photo');

      expect(await screen.findByText(UNCLEAR)).toBeTruthy();
      expect(screen.getByText(NO_TOTAL)).toBeTruthy();
      expect(mockRecognizer.calls).toHaveLength(2);
      expect(screen.queryByText(TIMED_OUT_COPY)).toBeNull();
      expect(screen.queryByText(/SECRET-LIB-TEXT|took too long/)).toBeNull();
      expect(router.getPathname()).toBe('/scan');
      await waitFor(() => expect(deleteTemps).toHaveBeenCalled());

      await press('Type it in');
      expect(await screen.findByText('Check the items')).toBeTruthy();
      expect(router.getPathname()).toBe('/bill');
      expect(getScanResult()?.items.map((i) => i.name)).toEqual(NO_TOTAL_ITEMS);
    });

    it('23 (R1): with the failure screen off, a timeout during the retry opens /bill with the first read', async () => {
      const os = jest.replaceProperty(Platform, 'OS', 'ios');
      try {
        mockConfig.showFailure = { web: true, native: false };
        mockConfig.nativePlan = { primary: 'native-current', retry: 'native-current' };
        mockRecognizer = timeoutAfterFirstRead(NO_TOTAL_READ);
        const router = await openScan();
        await press('Take photo');
        expect(await screen.findByText('Check the items')).toBeTruthy();
        expect(router.getPathname()).toBe('/bill');
        expect(getScanResult()?.items.map((i) => i.name)).toEqual(NO_TOTAL_ITEMS);
        expect(mockRecognizer.calls).toHaveLength(2);
      } finally {
        os.restore();
      }
    });

    it('23 (R1): a timeout on the only read still shows the timeout screen (nothing to keep)', async () => {
      mockConfig.nativePlan = { primary: 'native-current', retry: 'native-current' };
      mockRecognizer = createFakeRecognizer({ available: true, error: new RecognitionError('timeout') });
      await openScan();
      await press('Take photo');
      expect(await screen.findByText(TIMED_OUT_COPY)).toBeTruthy();
      expect(screen.queryByText(UNCLEAR)).toBeNull();
      expect(mockRecognizer.calls).toHaveLength(1);
    });

    it('46 (web, cv on): the first scan that loads OpenCV shows the longer preparing line; the next one does not', async () => {
      const os = jest.replaceProperty(Platform, 'OS', 'web');
      try {
        useWebLabels();
        mockConfig.cv = true;
        mockConfig.webPlan = { primary: 'web-crop', retry: null };
        let releasePrepare: (() => void) | undefined;
        const holdPrepare = () =>
          new Promise((resolve) => {
            releasePrepare = () => resolve({ uri: RESIZED, width: 1536, height: 2048 });
          });
        prepare.mockImplementationOnce(holdPrepare);
        const router = await openScan();
        await press('Take or upload photo');
        expect(await screen.findByText('Preparing photo… The first time takes a little longer.')).toBeTruthy();
        await act(async () => {
          releasePrepare?.();
        });
        expect(await screen.findByText('Check the items')).toBeTruthy();

        await act(async () => {
          globalRouter.back();
        });
        await waitFor(() => expect(router.getPathname()).toBe('/scan'));
        prepare.mockImplementationOnce(holdPrepare);
        await press('Take or upload photo');
        expect(await screen.findByText('Preparing photo…')).toBeTruthy();
        expect(screen.queryByText(/The first time/)).toBeNull();
        await act(async () => {
          releasePrepare?.();
        });
        expect(await screen.findByText('Check the items')).toBeTruthy();
      } finally {
        os.restore();
      }
    });

    it('R4 (web, cv on): a scan whose OpenCV fell back does not mark it loaded; the next scan still shows the longer line', async () => {
      const os = jest.replaceProperty(Platform, 'OS', 'web');
      try {
        useWebLabels();
        mockConfig.cv = true;
        mockConfig.webPlan = { primary: 'web-crop', retry: null };
        await storage.removeItem(CV_LOADED_KEY); // a device that never loaded OpenCV
        const text = getFixture('diner-simple').text;
        const parsed = parseReceipt(text);
        let release: (() => void) | undefined;
        mockScanOverride = () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                best: { text, parsed, verdict: assessQuality(text, parsed) },
                attempts: [],
                trace: [
                  { variant: 'web-crop', stage: 'locate', event: 'unavailable' },
                  { variant: 'web-crop', stage: 'normalize', event: 'fallback' },
                ],
              });
          });
        const router = await openScan();
        await press('Take or upload photo');
        expect(await screen.findByText('Preparing photo… The first time takes a little longer.')).toBeTruthy();
        await act(async () => {
          release?.();
        });
        expect(await screen.findByText('Check the items')).toBeTruthy();
        expect(await storage.getItem(CV_LOADED_KEY)).toBeNull();

        await act(async () => {
          globalRouter.back();
        });
        await waitFor(() => expect(router.getPathname()).toBe('/scan'));
        let releasePrepare: (() => void) | undefined;
        prepare.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releasePrepare = () => resolve({ uri: RESIZED, width: 1536, height: 2048 });
            }),
        );
        await press('Take or upload photo');
        expect(await screen.findByText('Preparing photo… The first time takes a little longer.')).toBeTruthy();
        await act(async () => {
          releasePrepare?.();
        });
        expect(await screen.findByText('Check the items')).toBeTruthy();
        // This one ran with no fallback, so now it is marked.
        await waitFor(async () => expect(await storage.getItem(CV_LOADED_KEY)).toBe('1'));
      } finally {
        os.restore();
      }
    });

    it('46 (web, cv off, today): preparing never shows the longer line', async () => {
      const os = jest.replaceProperty(Platform, 'OS', 'web');
      try {
        useWebLabels();
        let releasePrepare: (() => void) | undefined;
        prepare.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releasePrepare = () => resolve({ uri: RESIZED, width: 1536, height: 2048 });
            }),
        );
        await openScan();
        await press('Take or upload photo');
        expect(await screen.findByText('Preparing photo…')).toBeTruthy();
        expect(screen.queryByText(/The first time/)).toBeNull();
        await act(async () => {
          releasePrepare?.();
        });
        expect(await screen.findByText('Check the items')).toBeTruthy();
      } finally {
        os.restore();
      }
    });

    it('53: a scan that finishes after the screen is gone (sign-out unmounts it) stores nothing', async () => {
      mockRecognizer = createFakeRecognizer({ available: true, result: NO_TOTAL_READ });
      let finishFirst: ((t: unknown) => void) | undefined;
      const fixture = getFixture('diner-simple').text;
      mockRecognizer.recognize = () =>
        new Promise((resolve) => {
          finishFirst = () => resolve(fixture);
        });
      await openScan();
      await press('Take photo');
      expect(await screen.findByText('Reading receipt…')).toBeTruthy();
      screen.unmount();
      await act(async () => {
        finishFirst?.(undefined);
      });
      expect(getScanResult()).toBeNull();
    });
  });
});

// Spec: docs/specs/2026-11-25-scan-screen-redesign.md (criteria 1, 3, 4, 5). Visual change only:
// these pin the two centered choices, their copy and hints, and which controls each state shows.
describe('scan screen redesign: the two centered choices (spec 2026-11-25)', () => {
  const INTRO = 'Start a bill from your receipt.';
  const SCAN_HINT_NATIVE = "Point the camera at the receipt and we'll fill in the items.";
  const SCAN_HINT_WEB = "Use a photo of the receipt and we'll fill in the items.";
  const MANUAL_HINT = 'Type each item and its price yourself.';

  type Node = { props: { accessibilityLabel?: string }; children: (Node | string)[] };
  function textOf(n: Node | string): string {
    return typeof n === 'string' ? n : n.children.map(textOf).join('');
  }
  /**
   * Every button's accessible name, in screen order (its label, else its text). Since proposal P2
   * (visual pass V16) the header's "Home" back control is on every state; the test renderer puts the
   * native header's views after the content, so it is last here (on a device the bar is read first).
   */
  function buttonNames(): string[] {
    return screen.getAllByRole('button').map((b) => {
      const node = b as unknown as Node;
      return node.props.accessibilityLabel ?? textOf(node);
    });
  }

  it('1 (native): idle shows the title, the intro line and exactly two choices with their hints', async () => {
    await openScan();
    expect(screen.getByRole('header', { name: 'Scan receipt' })).toBeTruthy();
    expect(screen.getByText(INTRO)).toBeTruthy();
    expect(buttonNames()).toEqual(['Take photo', 'Enter items', 'Home']);

    const scan = screen.getByRole('button', { name: 'Take photo' });
    const manual = screen.getByRole('button', { name: 'Enter items' });
    expect(scan.props.accessibilityHint).toBe(SCAN_HINT_NATIVE);
    expect(manual.props.accessibilityHint).toBe(MANUAL_HINT);
    // The hint is also the visible line under each title.
    expect(screen.getByText(SCAN_HINT_NATIVE)).toBeTruthy();
    expect(screen.getByText(MANUAL_HINT)).toBeTruthy();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('1 (web): idle shows the web labels and the photo hint', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'web');
    try {
      useWebLabels();
      await openScan();
      expect(screen.getByText(INTRO)).toBeTruthy();
      expect(buttonNames()).toEqual(['Take or upload photo', 'Enter items', 'Home']);
      expect(screen.getByRole('button', { name: 'Take or upload photo' }).props.accessibilityHint).toBe(SCAN_HINT_WEB);
      expect(screen.getByRole('button', { name: 'Enter items' }).props.accessibilityHint).toBe(MANUAL_HINT);
      expect(screen.queryByText(SCAN_HINT_NATIVE)).toBeNull();
    } finally {
      os.restore();
    }
  });

  it('3: an error keeps both choices under the banner; the scan choice reads Try again with the same hint', async () => {
    mockRecognizer = createFakeRecognizer({ available: true, error: new RecognitionError('failed', 'X') });
    await openScan();
    await press('Take photo');

    expect(await screen.findByText(READ_FAILED)).toBeTruthy();
    expect(screen.getByText(INTRO)).toBeTruthy();
    expect(buttonNames()).toEqual(['Try again', 'Enter items', 'Home']);
    expect(screen.getByRole('button', { name: 'Try again' }).props.accessibilityHint).toBe(SCAN_HINT_NATIVE);
  });

  it('3: camera blocked shows Open Settings under the banner, then the two choices', async () => {
    captureReturns({ kind: 'permission', state: 'blocked' });
    await openScan();
    await press('Take photo');

    expect(screen.getByText(BLOCKED)).toBeTruthy();
    expect(buttonNames()).toEqual(['Open Settings', 'Try again', 'Enter items', 'Home']);
  });

  it('4 (native and web): unavailable shows the info line and only the Enter items choice', async () => {
    for (const os of ['ios', 'web'] as const) {
      const restore = jest.replaceProperty(Platform, 'OS', os);
      try {
        mockRecognizer = createFakeRecognizer({ available: false });
        const { unmount } = renderRouter('./app', { initialUrl: '/scan' });
        await screen.findByText('Scan receipt');
        expect(screen.getByText(UNAVAILABLE)).toBeTruthy();
        expect(screen.queryByText(INTRO)).toBeNull();
        expect(buttonNames()).toEqual(['Enter items', 'Home']);
        expect(screen.getByRole('button', { name: 'Enter items' }).props.accessibilityHint).toBe(MANUAL_HINT);
        unmount();
      } finally {
        restore.restore();
      }
    }
  });

  it('P2 (visual pass V16): the header Home goes home from idle and from the failure state, on native and web', async () => {
    for (const os of ['ios', 'web'] as const) {
      const restore = jest.replaceProperty(Platform, 'OS', os);
      try {
        if (os === 'web') useWebLabels();
        let router = await openScan();
        await press('Home');
        await waitFor(() => expect(router.getPathname()).toBe('/'));
        screen.unmount();

        mockRecognizer = createFakeRecognizer({ available: true, result: NO_TOTAL_READ });
        router = await openScan();
        await press(os === 'web' ? 'Take or upload photo' : 'Take photo');
        expect(await screen.findByText(NO_TOTAL)).toBeTruthy();
        await press('Home');
        await waitFor(() => expect(router.getPathname()).toBe('/'));
        screen.unmount();
      } finally {
        restore.restore();
      }
    }
  });

  it('P9 (visual pass V16): the failure state offers the same two cards, each showing its hint', async () => {
    mockRecognizer = createFakeRecognizer({ available: true, result: NO_TOTAL_READ });
    await openScan();
    await press('Take photo');
    expect(await screen.findByText(NO_TOTAL)).toBeTruthy();
    expect(buttonNames()).toEqual(['Retake photo', 'Type it in', 'Home']);
    expect(screen.getByText('Opens the camera so you can take a new photo.')).toBeTruthy();
    expect(screen.getByText('Opens the bill form with what was read filled in, so you can fix it.')).toBeTruthy();
  });

  it('5: while reading, the choices are gone and Cancel is the only control besides the header Home', async () => {
    mockRecognizer = createFakeRecognizer({ available: true, deferred: true, result: getFixture('diner-simple').text });
    await openScan();
    await press('Take photo');

    expect(await screen.findByText('Cancel')).toBeTruthy();
    expect(buttonNames()).toEqual(['Cancel', 'Home']);
    expect(screen.queryByText(INTRO)).toBeNull();
    await press('Cancel');
    expect(buttonNames()).toEqual(['Take photo', 'Enter items', 'Home']);
  });
});
