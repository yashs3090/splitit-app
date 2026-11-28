// Copy and sizing for the invite QR popup (components/QrSheet.tsx, opened by "Show QR code" in
// components/SharePanel.tsx and components/GroupInvite.tsx). Pure: no React, no I/O.
// Decisions: docs/decisions-to-review.md ("Invite QR" IQ-1…IQ-9, "QR popup" QS-1…).
import { layout, space } from './theme';

export const INVITE_QR_COPY = {
  show: 'Show QR code',
  showHint: 'Opens a QR code friends can scan to open the invite link',
  caption: 'Friends can scan this with their phone camera.',
  imageLabel: 'QR code for the invite link',
  linkA11y: (url: string) => `Invite link ${url}`,
  copy: 'Copy link',
  copied: 'Link copied',
  copyFailed: "Couldn't copy. Select the link and copy it yourself.",
  done: 'Done',
  /** The scrim behind the Android/web sheet (a button for screen readers and mice). */
  close: 'Close',
} as const;

export type QrSheetSubject = { kind: 'bill' } | { kind: 'group'; name?: string };

/** "Scan to join Tahoe trip" / "Scan to join this bill". The group name is the member-set name, never URL text. */
export function qrSheetTitle(subject: QrSheetSubject): string {
  if (subject.kind === 'bill') return 'Scan to join this bill';
  const name = (subject.name ?? '').replace(/\s+/gu, ' ').trim();
  return name === '' ? 'Scan to join this group' : `Scan to join ${name}`;
}

/** Smallest and largest code, in points. */
export const QR_MIN = 160;
export const QR_MAX = 300;
/**
 * Height the sheet needs besides the tile (title, caption, link, Copy link, Done, padding and safe
 * areas), so on a short window the code shrinks instead of pushing Done off screen.
 */
const RESERVED_HEIGHT = 360;
/**
 * Scanners need a light margin of 4 modules. The smallest code we draw is 25 modules (version 2), so
 * its modules are the largest: 4/25 of the size covers every link length.
 */
const QUIET_RATIO = 4 / 25;

/** The code's size and its quiet zone for a window: as big as fits the sheet, whole points. */
export function qrTileLayout(windowWidth: number, windowHeight: number): { size: number; quietZone: number } {
  const perSize = 1 + 2 * QUIET_RATIO;
  const width = Math.min(windowWidth, layout.content) - 2 * space.lg;
  const byHeight = (windowHeight - RESERVED_HEIGHT) / perSize;
  const first = Math.floor(Math.max(QR_MIN, Math.min(QR_MAX, width / perSize, byHeight)));
  const quietZone = Math.ceil(first * QUIET_RATIO);
  // Rounding the margin up can push the tile 1–2 pt past the width: take it off the code instead.
  const size = Math.max(QR_MIN, Math.min(first, Math.floor(width) - 2 * quietZone));
  return { size, quietZone };
}
