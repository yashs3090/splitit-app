// Shared types for receipt recognition and parsing (spec: docs/specs/2026-11-20-m1a-scan-receipt.md).
// All money values are integer cents.

/** Image pixels, top-left origin. */
export type Box = { x: number; y: number; width: number; height: number };
export type RecognizedLine = {
  text: string;
  box?: Box;
  /** The engine's confidence in the line, 0–100. Web (Tesseract) only; native leaves it unset. The parser ignores it. */
  confidence?: number;
};
/** Lines in the order the recognizer returned them. */
export type RecognizedText = { lines: RecognizedLine[] };

export type ItemFlag = 'qty_price_mismatch';

export type ParsedItem = {
  /** Trimmed, modifiers not included. */
  name: string;
  /** Integer >= 1. */
  qty: number;
  /** Printed unit price, or totalCents / qty when exact, else null. */
  unitCents: number | null;
  /** The line's price including priced modifiers. */
  totalCents: number;
  /** e.g. ["avocado", "no onions"]; shown in the form as the note "avocado, no onions". */
  modifiers: string[];
  /** Set by the parser when the printed qty × unit ≠ line price. */
  flags?: ItemFlag[];
};

export type Discount = {
  label: string;
  /** Positive cents. */
  cents: number;
  appliesTo: 'subtotal' | 'total';
};

export type ReviewReason =
  | 'no_items'
  | 'missing_subtotal'
  | 'missing_total'
  | 'items_vs_subtotal'
  | 'subtotal_vs_total'
  | 'qty_price_mismatch';

export type ParsedReceipt = {
  items: ParsedItem[];
  subtotalCents: number | null;
  /** Sum of all tax lines. */
  taxCents: number | null;
  /** null = no tip line found (not the same as 0). */
  tipCents: number | null;
  /** Service charge / service fee. */
  feesCents: number | null;
  discounts: Discount[];
  totalCents: number | null;
  /** true iff reasons.length > 0 */
  needsReview: boolean;
  reasons: ReviewReason[];
};
