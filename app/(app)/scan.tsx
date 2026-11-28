// Scan screen: take (or, on web, pick) a photo, read it on the device, open the bill form prefilled.
// Spec: docs/specs/2026-11-20-m1a-scan-receipt.md (Task 7; A3 / Task 9 for web, progress and cancel).
// The read itself goes through the staged scan pipeline (`lib/scanReceipt`, spec
// docs/specs/2026-11-22-web-opencv-preprocessing.md Task 3), which also frees the photo and every
// intermediate image however the scan ends.
//
// Branches on `recognizer.isAvailable()`, not `Platform.OS`, so both branches are testable. Native
// builds without the OCR module (e.g. Expo Go) and browsers without WebAssembly fall back to the
// manual form. Capture goes through `lib/capturePhoto` (camera on native, file picker on web).
// Privacy: no console calls here, and the parsed receipt goes through `lib/scanSession`, never the URL.
// Every message shown is fixed app copy; library and error text is never displayed.
// A read the pipeline judges not ok (`assessQuality`) shows the failure screen, "Retake photo /
// Type it in", when `SHOW_FAILURE_SCREEN` is on for the platform (spec 2026-11-22 Task 10); which
// screen and which copy for which verdict is decided in `lib/scanScreen.ts`.
// Layout (spec 2026-11-25 scan screen redesign): every state sits in one centered column; idle and the
// error states offer two equal choice cards, scan and "Enter items".
import { useRouter } from 'expo-router';
import Camera from 'lucide-react-native/icons/camera';
import PencilLine from 'lucide-react-native/icons/pencil-line';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChoiceCard } from '@/components/ChoiceCard';
import { Banner, BannerText } from '@/components/ui/Banner';
import { BackHeader } from '@/components/ui/BackHeader';
import { Button } from '@/components/ui/Button';
import { CAPTURE_LABEL, capturePhoto, MANUAL_ENTRY_LABEL } from '@/lib/capturePhoto';
import { deleteTempImages } from '@/lib/prepareImage';
import { RecognitionError } from '@/lib/recognitionError';
import { recognizer } from '@/lib/recognizer';
import { scanReceipt } from '@/lib/scanReceipt';
import type { ParsedReceipt } from '@/lib/receiptTypes';
import { PIPELINE, SHOW_FAILURE_SCREEN, WEB_CV_PREPROCESS } from '@/lib/scanPipeline/config';
import {
  CHOICE_COPY,
  choiceHints,
  CV_LOADED_KEY,
  cvRan,
  FAILURE_COPY,
  failureHints,
  progressCopy,
  scanLoadsCv,
  scanOutcome,
  showsProgressBar,
} from '@/lib/scanScreen';
import { clearScanResult, setScanResult } from '@/lib/scanSession';
import { storage } from '@/lib/storage';
import { backToTabs } from '@/lib/tabsNav';
import type { RecognitionStage } from '@/lib/textRecognition';
import { layout, radius, space, type, useTheme } from '@/lib/theme';

type Status =
  | 'idle'
  | 'ask'
  | 'blocked'
  | 'reading'
  | 'read_failed'
  | 'load_failed'
  | 'timed_out'
  | 'camera_failed'
  | 'unclear';

/** The failure screen's content: the allow-listed reason line and what was read (kept for "Type it in"). */
type Unclear = { reason: string | null; parsed: ParsedReceipt };

const COPY = {
  ask: 'SplitIt needs the camera to read your receipt.',
  blocked: 'Camera access is off for SplitIt. Turn it on in Settings.',
  read_failed:
    "Couldn't read that photo. Try again with the receipt flat and well lit, or enter the items yourself.",
  load_failed: "Couldn't load the text reader. Check your connection and try again, or enter the items yourself.",
  camera_failed: "Couldn't open the camera. Try again, or enter the items yourself.",
  unavailable: 'Scanning works in the iPhone app. You can enter the items yourself.',
} as const;

function errorStatus(e: unknown): Status | 'cancelled' {
  if (e instanceof RecognitionError) {
    if (e.code === 'cancelled') return 'cancelled';
    if (e.code === 'engine_load_failed') return 'load_failed';
    if (e.code === 'timeout') return 'timed_out';
  }
  return 'read_failed';
}

export default function ScanScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  // Checked once: availability doesn't change while the app runs.
  const [available] = useState(() => recognizer.isAvailable());
  const [status, setStatus] = useState<Status>('idle');
  const [stage, setStage] = useState<RecognitionStage>('preparing');
  const [progress, setProgress] = useState<number | null>(null);
  // The read behind the failure screen; null on every other screen.
  const [unclear, setUnclear] = useState<Unclear | null>(null);
  // Web, cv on: this device hasn't downloaded the image tools yet, so preparing takes longer.
  const [firstCvLoad, setFirstCvLoad] = useState(false);
  const platform = Platform.OS === 'web' ? 'web' : 'native';
  // The running scan. Cancel aborts it; a newer scan or unmount makes the old one's results ignored.
  const current = useRef<AbortController | null>(null);
  // The scan whose photo picker/camera is still open (cleared once capture settles).
  const capturing = useRef<AbortController | null>(null);

  useEffect(() => () => current.current?.abort(), []);

  function onOpenSettings() {
    Linking.openSettings().catch(() => {
      // Nothing useful to show: the message already says where the setting is.
    });
  }

  function onTypeInstead() {
    current.current?.abort();
    clearScanResult();
    router.push('/bill');
  }

  function onRetake() {
    clearScanResult();
    setUnclear(null);
    // Idle behind the camera / picker, so a web picker that never settles leaves a usable screen.
    setStatus('idle');
    onTakePhoto();
  }

  function onTypeItIn() {
    current.current?.abort();
    if (unclear) setScanResult(unclear.parsed);
    else clearScanResult();
    router.push('/bill');
  }

  function onCancel() {
    current.current?.abort();
    current.current = null;
    setStatus('idle');
    setProgress(null);
  }

  function onTakePhoto() {
    const running = current.current;
    if (running && !running.signal.aborted) {
      // Some browsers never fire the file input's `cancel` event, so a dismissed web picker never
      // settles. A new press while the picker is open replaces that scan instead of being ignored;
      // if the old picker settles later, its signal is aborted and its photo is discarded.
      if (Platform.OS !== 'web' || capturing.current !== running) return; // already scanning
      running.abort();
    }
    const controller = new AbortController();
    current.current = controller;
    void scan(controller).finally(() => {
      if (current.current === controller) current.current = null;
    });
  }

  async function scan(controller: AbortController) {
    const { signal } = controller;
    // Every state change goes through this, so a cancelled scan can't overwrite a newer screen state.
    const show = (s: Status) => {
      if (!signal.aborted) setStatus(s);
    };

    let capturedUri: string | undefined;
    capturing.current = controller;
    try {
      const captured = await capturePhoto();
      if (captured.kind === 'permission') return show(captured.state);
      if (captured.kind === 'cancelled') return show('idle'); // stay here, no error
      capturedUri = captured.uri;
    } catch {
      return show('camera_failed');
    } finally {
      if (capturing.current === controller) capturing.current = null;
    }

    if (signal.aborted) {
      await deleteTempImages([capturedUri]);
      return;
    }
    setProgress(null);
    setUnclear(null);
    setStage('preparing');
    show('reading');
    const loadsCv = scanLoadsCv(platform, WEB_CV_PREPROCESS, PIPELINE.web);
    setFirstCvLoad(false);
    if (loadsCv) {
      storage
        .getItem(CV_LOADED_KEY)
        .then((v) => {
          if (!signal.aborted) setFirstCvLoad(v === null);
        })
        .catch(() => {
          // Only changes a status line; the short one is fine.
        });
    }
    let lastStage: RecognitionStage = 'preparing';
    try {
      // From here the pipeline owns the photo and frees it (and its resized copies) when it ends.
      const { best, trace } = await scanReceipt(capturedUri, {
        signal,
        onStage: (s) => {
          if (signal.aborted) return;
          // A new step starts its own progress; don't carry the last read's bar into it.
          if (s !== lastStage && (s === 'preparing' || s === 'retrying')) setProgress(null);
          lastStage = s;
          setStage(s);
        },
        onProgress: (f) => {
          if (!signal.aborted) setProgress(f);
        },
      });
      if (signal.aborted) return;
      // Only once OpenCV really ran: a scan that fell back to today's path didn't download it (R4).
      if (loadsCv && cvRan(trace)) {
        storage.setItem(CV_LOADED_KEY, '1').catch(() => {
          // Only changes a status line next time.
        });
      }
      const outcome = scanOutcome(
        { lineCount: best.text.lines.length, itemCount: best.parsed.items.length, verdict: best.verdict },
        SHOW_FAILURE_SCREEN[platform],
      );
      if (outcome.kind === 'read_failed') return show('read_failed');
      if (outcome.kind === 'failure') {
        setUnclear({ reason: outcome.reason, parsed: best.parsed });
        return show('unclear');
      }
      setScanResult(best.parsed);
      show('idle');
      router.push('/bill');
    } catch (e) {
      const next = errorStatus(e);
      show(next === 'cancelled' ? 'idle' : next);
    }
  }

  const hints = choiceHints(platform);

  if (!available) {
    return (
      <ScanFrame intro={COPY.unavailable}>
        <View style={styles.choices}>
          <ChoiceCard title={MANUAL_ENTRY_LABEL} hint={hints.manual} icon={PencilLine} onPress={onTypeInstead} style={styles.choice} />
        </View>
      </ScanFrame>
    );
  }

  if (status === 'reading') {
    const percent = progress === null ? null : Math.round(progress * 100);
    const label = progressCopy(stage, { firstCvLoad });
    const bar = percent !== null && showsProgressBar(stage);
    return (
      <ScanFrame>
        <View style={styles.reading}>
          {bar ? null : <ActivityIndicator size="large" color={colors.primary} />}
          <Text accessibilityLiveRegion="polite" style={[type.body, styles.center, { color: colors.text }]}>
            {label}
          </Text>
          {bar ? (
            <View
              accessible
              accessibilityRole="progressbar"
              accessibilityLabel="Reading progress"
              accessibilityValue={{ min: 0, max: 100, now: percent }}
              style={[styles.track, { backgroundColor: colors.surfaceMuted }]}
            >
              <View style={[styles.fill, { width: `${percent}%`, backgroundColor: colors.primary }]} />
            </View>
          ) : null}
          <Button label="Cancel" variant="secondary" onPress={onCancel} style={styles.selfCenter} />
        </View>
      </ScanFrame>
    );
  }

  if ((status === 'unclear' && unclear) || status === 'timed_out') {
    // The failure screen. A timeout uses the same layout and buttons, with nothing read to pre-fill.
    const failure = failureHints(platform, unclear !== null);
    return (
      <ScanFrame>
        <View style={styles.stack}>
          <Banner tone="warning" title={unclear ? FAILURE_COPY.title : FAILURE_COPY.timedOutTitle} alert>
            {unclear?.reason ? <BannerText>{unclear.reason}</BannerText> : null}
          </Banner>
          <Text style={[type.body, styles.center, { color: colors.textMuted }]}>{FAILURE_COPY.tip}</Text>
        </View>
        {/* The same two-card language as the idle screen (proposal P9). Each card's hint is the line it shows. */}
        <View style={styles.choices}>
          <ChoiceCard title={FAILURE_COPY.retake} hint={failure.retake} icon={Camera} onPress={onRetake} style={styles.choice} />
          <ChoiceCard title={FAILURE_COPY.typeIn} hint={failure.typeIn} icon={PencilLine} onPress={onTypeItIn} style={styles.choice} />
        </View>
      </ScanFrame>
    );
  }

  const message =
    status === 'ask' ||
    status === 'blocked' ||
    status === 'read_failed' ||
    status === 'load_failed' ||
    status === 'camera_failed'
      ? COPY[status]
      : null;
  const tone = status === 'ask' || status === 'blocked' ? 'warning' : 'error';

  return (
    <ScanFrame intro={CHOICE_COPY.intro}>
      {message ? (
        <View style={styles.stack}>
          <Banner tone={tone} alert>
            <BannerText>{message}</BannerText>
          </Banner>
          {status === 'blocked' ? (
            <Button label="Open Settings" onPress={onOpenSettings} style={styles.selfCenter} />
          ) : null}
        </View>
      ) : null}
      <View style={styles.choices}>
        <ChoiceCard
          title={status === 'idle' ? CAPTURE_LABEL : 'Try again'}
          hint={hints.scan}
          icon={Camera}
          onPress={onTakePhoto}
          style={styles.choice}
        />
        <ChoiceCard
          title={MANUAL_ENTRY_LABEL}
          hint={hints.manual}
          icon={PencilLine}
          onPress={onTypeInstead}
          style={styles.choice}
        />
      </View>
    </ScanFrame>
  );
}

/**
 * Every state's frame: the title (and an optional quiet line under it) above the state's content,
 * the whole group centered on the screen. Scrolls when large text sizes make it taller than the screen.
 */
function ScanFrame({ intro, children }: { intro?: string; children: ReactNode }) {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <>
      {/*
        Back to Home on every state (proposal P2): pops to the tabs when they're under this screen
        (keeping the tab (+) was pressed on, tab-bar spec criterion 29), otherwise opens them.
        Leaving mid-scan aborts the scan (the unmount cleanup).
      */}
      <BackHeader
        title="Scan receipt"
        back={{ label: 'Home', accessibilityLabel: 'Home', accessibilityHint: 'Returns to your bills', onPress: () => backToTabs(router) }}
      />
      <ScrollView
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={[
          styles.frame,
          { paddingTop: space.xl, paddingBottom: insets.bottom + space.xl },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.column}>
          <View style={styles.heading}>
            <Text accessibilityRole="header" style={[type.title, styles.center, { color: colors.text }]}>
              Scan receipt
            </Text>
            {intro ? <Text style={[type.body, styles.center, { color: colors.textMuted }]}>{intro}</Text> : null}
          </View>
          {children}
        </View>
      </ScrollView>
    </>
  );
}

/** Below this a choice's hint wraps awkwardly, so the choices stack (phones) instead. */
const CHOICE_MIN_WIDTH = 220;

const styles = StyleSheet.create({
  frame: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: layout.screenPadding },
  // Two choices sit side by side once each gets CHOICE_MIN_WIDTH of the column.
  column: { width: '100%', maxWidth: layout.content, gap: space.xl },
  heading: { gap: space.xs, alignItems: 'center' },
  center: { textAlign: 'center' },
  selfCenter: { alignSelf: 'center' },
  stack: { gap: space.md },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  choice: { flexGrow: 1, flexBasis: CHOICE_MIN_WIDTH },
  reading: { alignItems: 'center', gap: space.lg },
  track: {
    width: '100%',
    maxWidth: layout.message,
    height: space.sm,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  fill: { height: '100%' },
});
