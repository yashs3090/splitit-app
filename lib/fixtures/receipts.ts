// Receipt fixtures for lib/receiptText.ts. Most are synthetic. The `tesseract-*` ones are the real
// output of the web pipeline (Tesseract.js, LSTM only, PSM 6, line boxes) on three real receipt
// photos (El Chalan twice), kept verbatim except: staff names, addresses and email, website and
// phone lines are replaced or removed. The photos are never committed. No card or customer data.
// Each fixture pairs recognizer output with the ParsedReceipt the parser must produce.
import type { ParsedItem, ParsedReceipt, RecognizedLine, RecognizedText } from '../receiptTypes';

export type ReceiptFixture = { name: string; text: RecognizedText; expected: ParsedReceipt };

/** Box-less recognizer output, one line per printed row. */
export function linesOf(...texts: string[]): RecognizedText {
  return { lines: texts.map((text) => ({ text })) };
}

function item(name: string, totalCents: number, extra: Partial<ParsedItem> = {}): ParsedItem {
  return { name, qty: 1, unitCents: totalCents, totalCents, modifiers: [], ...extra };
}

function receipt(r: Partial<ParsedReceipt> & Pick<ParsedReceipt, 'items'>): ParsedReceipt {
  const reasons = r.reasons ?? [];
  return {
    subtotalCents: null,
    taxCents: null,
    tipCents: null,
    feesCents: null,
    discounts: [],
    totalCents: null,
    ...r,
    reasons,
    needsReview: reasons.length > 0,
  };
}

// Fixture 10: names first (top to bottom), then prices in reverse order, slightly skewed in y.
const H = 40;
const name = (text: string, y: number): RecognizedLine => ({ text, box: { x: 40, y, width: 260, height: H } });
const price = (text: string, y: number): RecognizedLine => ({ text, box: { x: 620, y, width: 90, height: H } });
const visionColumns: RecognizedText = {
  lines: [
    { text: 'GRILL HOUSE', box: { x: 250, y: 60, width: 300, height: 50 } },
    name('Fish Tacos', 200),
    name('Rice Bowl', 260),
    name('Agua Fresca', 320),
    name('Subtotal', 400),
    name('Tax', 460),
    name('Total', 520),
    price('30.04', 526),
    price('2.29', 465),
    price('27.75', 404),
    price('3.50', 324),
    price('11.25', 263),
    price('13.00', 203),
  ],
};

// Same receipt photographed with a ~2 degree tilt: each price sits 21px below its name, more than
// half the 40px line height, so plain y-grouping would split every row (review R1).
const visionTilted: RecognizedText = {
  lines: [
    { text: 'GRILL HOUSE', box: { x: 250, y: 60, width: 300, height: 50 } },
    name('Fish Tacos', 200),
    name('Rice Bowl', 260),
    name('Agua Fresca', 320),
    name('Subtotal', 400),
    name('Tax', 460),
    name('Total', 520),
    price('30.04', 541),
    price('2.29', 481),
    price('27.75', 421),
    price('3.50', 341),
    price('11.25', 281),
    price('13.00', 221),
  ],
};

const visionExpected = receipt({
  items: [item('Fish Tacos', 1300), item('Rice Bowl', 1125), item('Agua Fresca', 350)],
  subtotalCents: 2775,
  taxCents: 229,
  totalCents: 3004,
});

/** The same receipt as fixture 10, printed as whole rows with no boxes. */
// ---------- real Tesseract output (backlog item 2) ----------
const ocr = (text: string, x: number, y: number, width: number, height: number): RecognizedLine => ({
  text,
  box: { x, y, width, height },
});

// El Chalan (Miami), 866x1390 photo with an "alamy" watermark. Printed: ITEM QTY PRICE columns;
// Causa de Pollo 1 $8.95, Ceviche de Camarones 1 $16.95, Limonada 1 $4.00, Pescado al Ajillo 1 $15.95;
// Subtotal $45.85, Total Taxes $3.67, Grand Total $49.52, Amount Due $49.52, a 15/20/25% tip guide.
// Tesseract itself lost the Causa price ("AE da fe") and the Amount Due line ("mount De: wa a").
const tesseractElChalan: RecognizedText = {
  lines: [
    ocr("\"1 aoe as)             alamy", 153, 101, 629, 64),
    ocr("Cag vee vise Ta", 741, 360, 3, 3),
    // (a line with the restaurant email address, removed)
    ocr("TABLE: 13 - 1 Guest             \"", 230, 375, 508, 49),
    ocr("Your Server was Sam            4", 218, 431, 475, 22),
    ocr("3/12/2016 1:13:51 PM          /", 232, 452, 450, 37),
    ocr("v             Sequence #: 0000068            /", 9, 488, 659, 22),
    ocr("LU             1D #: 0389450                     al", 4, 491, 853, 52),
    ocr("NE ITEM                    QTY PRICE", 20, 542, 608, 29),
    ocr("4    CAUSA DE POLLO     i  AE da fe", 16, 582, 620, 42),
    ocr("CEVICHE DE CAMARONES           1 $16.95     a", 92, 628, 646, 31),
    ocr("LIMONADA                   1 $4.00", 94, 657, 550, 27),
    ocr("PESCADO AL AJILLO             1 $15.95", 94, 687, 554, 27),
    ocr("Subtotal                         $45.85", 302, 746, 354, 27),
    ocr("Total Taxes        $3.67", 304, 777, 355, 27),
    ocr("Grand Total         $49.52", 309, 839, 361, 30),
    ocr("mount De:        wa a", 313, 872, 469, 63),
    ocr("15%         20%        25%        X", 174, 925, 607, 56),
    ocr("$7.43       $9.90       $12.38        R", 159, 958, 631, 39),
    ocr("TIP 1S NOT IKCLUDED  PROPINA NO INCLUIDA", 103, 1025, 588, 45),
    ocr("THANK YOU - GRACIAS!!!               4", 251, 1066, 592, 35),
    ocr("Guest Check           i", 324, 1105, 372, 35),
    ocr("pr            =      <= =mz=zzoESSESSSSESSSSSSSSES", 16, 1138, 680, 46),
    ocr("c                          ?        2  ~~", 46, 1177, 774, 51),
    ocr("p>                                      ON", 12, 1213, 740, 32),
    ocr("In              a          welll £2 a TN", 23, 1239, 684, 71),
    ocr("alamy                             edie", 50, 1316, 765, 59),
  ],
};

// La Cabana (Venice, CA), resized to 1542x2048 like the app does. Printed: qty before the name,
// "6." is a menu number, the price is glued to ")"; Subtotal 52.70, Sales Tax 5.01, Total 57.71,
// then a cash-discount price "Pay With Cash: 55.49" that is not the total.
// Tesseract itself read the total as "57.1".
const tesseractLaCabana: RecognizedText = {
  lines: [
    ocr("5                                                      |", 95, 106, 1295, 73),
    ocr("en", 652, 350, 133, 38),
    ocr("i                            AR)   =                            $", 115, 403, 1266, 70),
    ocr("|                fr — GAA =                i", 117, 457, 1228, 73),
    ocr("5                         ~~                          :", 118, 517, 1227, 40),
    ocr("la Casana               J", 601, 620, 769, 79),
    ocr("ol                La Cabana - Venice", 87, 704, 776, 55),
    ocr(";                    100 Example Ave", 124, 758, 674, 44),
    ocr("4                 Example City, CA 00000", 126, 805, 708, 41),
    ocr("2A     Opened: 03/10/2024 1:06 pm", 88, 888, 687, 52),
    ocr("i     Order: 1809                        Check: 1", 126, 936, 980, 46),
    ocr(":     Order Type: Dine In", 126, 982, 506, 47),
    ocr("N     Name: Table 15", 107, 1027, 422, 40),
    ocr("-    :     Server: Sam                          =e", 17, 1071, 1137, 59),
    ocr("1 Dos Tacos (Brunch)                18.00", 252, 1155, 850, 40),
    ocr("1 6. Taco y Enchilada (Super Combo)21.95", 252, 1199, 849, 42),
    ocr("1 Brunch Reg Lime Margarita        12.75", 253, 1245, 846, 42),
    ocr("|     Subtotal                             52.70", 135, 1312, 963, 56),
    ocr("Sales Tax                             5.01", 252, 1370, 839, 43),
    ocr("Total                  57.1", 254, 1447, 830, 65),
    ocr("Pay With Cash:         55.49", 255, 1530, 834, 71),
    ocr("B      Customer copy", 62, 1626, 446, 49),
    ocr(";     |                     Thank you!", 46, 1695, 712, 42),
  ],
};

// ---------- real web-pipeline captures, 2026-11-22 (after the symbol-only word filter) ----------
// Exactly what `mapTesseractResult` gives for the browser's Tesseract output, except: the server
// names are replaced with "Sam", and the email, street address, city and phone lines are removed.

// El Chalan, original-size photo. Tesseract read the Causa row's qty column as "RTE" and picked up
// a stray "4" before the name; the header ITEM QTY PRICE says the qty comes after the name.
const tesseractElChalanWeb: RecognizedText = {
  lines: [
    ocr('a re 1.', 12, 0, 571, 25),
    ocr('A', 47, 25, 21, 30),
    ocr(': alamy', 375, 101, 407, 54),
    // (a line with the restaurant email address, removed)
    ocr('TABLE: 13 - 1 Guest 4', 230, 375, 508, 49),
    ocr('Your Server was Sam 4', 221, 432, 471, 21),
    ocr('3/12/2016 1:13:51 PM', 232, 452, 450, 38),
    ocr('3 Sequence #: 0000068', 10, 488, 658, 22),
    ocr('1 1D #: 0389450 al', 5, 491, 852, 52),
    ocr('oy ITEM QTY PRICE', 20, 542, 608, 29),
    ocr('4 CAUSA DE POLLO RTE $8.95', 16, 582, 620, 42),
    ocr('CEVICHE DE CAMARONES 1 $16.95 a', 92, 628, 646, 31),
    ocr('LIMONADA 1 $4.00', 94, 657, 550, 27),
    ocr('PESCADO AL AJILLO 1 $15.95', 94, 687, 554, 27),
    ocr('Subtotal $45.85', 302, 747, 354, 26),
    ocr('Total Taxes $3.67', 304, 777, 355, 27),
    ocr('Grand Total $49.52', 309, 839, 361, 30),
    ocr('mount De: wa a', 313, 872, 469, 63),
    ocr('15% 20% 25% X', 174, 925, 607, 56),
    ocr('$7.43 $9.90 $12.38 C', 159, 958, 628, 40),
    ocr('PN (ERR SS A', 335, 992, 460, 24),
    ocr('TIP IS NOT INCLUDED PROPINA NO INCLUIDA', 102, 1025, 589, 45),
    ocr('THANK YOU - GRACIAS!!! 2', 251, 1066, 591, 35),
    ocr('L Guest Check RE', 60, 1104, 636, 50),
    ocr('TTT Sine', 16, 1145, 560, 41),
    ocr('C g 0p', 46, 1178, 774, 55),
    ocr('S (N', 16, 1224, 736, 21),
    ocr('n a ell i iy °N', 23, 1239, 678, 72),
    ocr('alamy iid', 50, 1316, 765, 59),
  ],
};

// Raintree, resized to 1600px. Printed: Subtotal 104.00, Tax 6.77, Gratuity 15.60, then
// "09:19PM Total 126.37" (time first, "Total" read as "Tota)"). The photo's tilt makes the row
// grouping put the Gratuity and Total lines on one row.
const tesseractRaintreeWeb: RecognizedText = {
  lines: [
    ocr('fi', 384, 50, 189, 146),
    // (street address, city, website and phone lines, removed)
    ocr('20003 Sam', 106, 444, 239, 54),
    ocr('161 60/1 Chk 2384 Gst 2', 89, 537, 718, 82),
    ocr("Nov1g'17 07:38rM", 298, 597, 294, 61),
    ocr('1 607 FILET 26.00', 120, 679, 626, 80),
    ocr('1 MAHI 26.00', 117, 721, 623, 82),
    ocr('1 S08 Cup BIsOuE 3.00', 114, 768, 625, 82),
    ocr('1 CUP BISQUE 5.00', 113, 810, 623, 83),
    ocr('1 SUB HOUSE SALAD 2.00', 110, 856, 627, 84),
    ocr('1 REESES COOKIE 7.00', 106, 900, 627, 84),
    ocr('2 GL PINOT GRIGIO 16.00', 99, 945, 627, 83),
    ocr('1 RAINTREE Rupy 10.00', 18, 992, 707, 82),
    ocr('1 NUTTY IRISH ICE 9.00', 99, 1035, 623, 82),
    ocr('Subtotal 104.00', 120, 1120, 598, 85),
    ocr('Tax 6.77', 124, 1164, 591, 86),
    ocr('Gratuity 15.60', 117, 1212, 594, 83),
    ocr('09:19PM Tota) 126.37', 0, 1255, 707, 75),
    ocr('15% GRATUITY', 117, 1348, 420, 63),
    ocr('IS INCLUDED', 110, 1391, 416, 64),
    ocr('17% ON SEPARATE', 113, 1437, 527, 71),
    ocr('CHECKS', 103, 1482, 238, 47),
  ],
};

export const visionColumnsBoxless = linesOf(
  'GRILL HOUSE',
  'Fish Tacos 13.00',
  'Rice Bowl 11.25',
  'Agua Fresca 3.50',
  'Subtotal 27.75',
  'Tax 2.29',
  'Total 30.04',
);

export const receiptFixtures: ReceiptFixture[] = [
  {
    name: 'diner-simple',
    text: linesOf(
      'THE CORNER DINER',
      'Cheeseburger $12.99',
      'Caesar Salad $9.50',
      'Iced Tea $3.25',
      'Subtotal $25.74',
      'Tax $2.12',
      'Tip $5.00',
      'Total $32.86',
    ),
    expected: receipt({
      items: [item('Cheeseburger', 1299), item('Caesar Salad', 950), item('Iced Tea', 325)],
      subtotalCents: 2574,
      taxCents: 212,
      tipCents: 500,
      totalCents: 3286,
    }),
  },
  {
    name: 'qty-and-at',
    text: linesOf(
      'BURGER BARN',
      '2 x Burger 25.98',
      '3 Fries 11.97',
      'Soda 2 @ 2.50 5.00',
      'Subtotal 42.95',
      'Tax 3.44',
      'Total 46.39',
    ),
    expected: receipt({
      items: [
        item('Burger', 2598, { qty: 2, unitCents: 1299 }),
        item('Fries', 1197, { qty: 3, unitCents: 399 }),
        item('Soda', 500, { qty: 2, unitCents: 250 }),
      ],
      subtotalCents: 4295,
      taxCents: 344,
      totalCents: 4639,
    }),
  },
  {
    name: 'modifiers',
    text: linesOf('Bowl 11.50', '+ avocado 1.50', 'no onions', 'Lemonade 4.00', 'Subtotal 17.00', 'Tax 1.36', 'Total 18.36'),
    expected: receipt({
      items: [item('Bowl', 1300, { modifiers: ['avocado', 'no onions'] }), item('Lemonade', 400)],
      subtotalCents: 1700,
      taxCents: 136,
      totalCents: 1836,
    }),
  },
  {
    name: 'discount-before-subtotal',
    // The separator row means the discount is not directly under an item, so it stays bill-level (A2.2).
    text: linesOf('Wings 10.00', 'Nachos 9.50', '----------', 'Happy Hour -3.00', 'Subtotal 16.50', 'Tax 1.32', 'Total 17.82'),
    expected: receipt({
      items: [item('Wings', 1000), item('Nachos', 950)],
      discounts: [{ label: 'Happy Hour', cents: 300, appliesTo: 'subtotal' }],
      subtotalCents: 1650,
      taxCents: 132,
      totalCents: 1782,
    }),
  },
  {
    name: 'discount-after-subtotal',
    text: linesOf('Pasta 18.00', 'Salad 12.00', 'Subtotal 30.00', 'Coupon (5.00)', 'Tax 2.40', 'Total 27.40'),
    expected: receipt({
      items: [item('Pasta', 1800), item('Salad', 1200)],
      discounts: [{ label: 'Coupon', cents: 500, appliesTo: 'total' }],
      subtotalCents: 3000,
      taxCents: 240,
      totalCents: 2740,
    }),
  },
  {
    name: 'no-tip-no-dollar',
    text: linesOf('TACO STAND', 'Tacos 8.75', 'Horchata 3.50', 'Subtotal 12.25', 'Sales Tax 1.01', 'Total 13.26'),
    expected: receipt({
      items: [item('Tacos', 875), item('Horchata', 350)],
      subtotalCents: 1225,
      taxCents: 101,
      totalCents: 1326,
    }),
  },
  {
    name: 'suggested-tip-block',
    text: linesOf(
      'Pho 18.00',
      'Spring Rolls 9.00',
      'Thai Tea 5.00',
      'Banh Mi 18.00',
      'Subtotal 50.00',
      'Tax 4.00',
      'Total 54.00',
      'Suggested gratuity',
      '18% 9.00',
      '20% 10.00',
      '22% 11.00',
      'Thank you!',
    ),
    expected: receipt({
      items: [item('Pho', 1800), item('Spring Rolls', 900), item('Thai Tea', 500), item('Banh Mi', 1800)],
      subtotalCents: 5000,
      taxCents: 400,
      totalCents: 5400,
    }),
  },
  {
    name: 'two-taxes-service-charge',
    text: linesOf(
      'Steak 42.00',
      'Salmon 28.00',
      'Subtotal 70.00',
      'State Tax 4.38',
      'City Tax 1.75',
      'Service charge 18% 12.60',
      'Total 88.73',
    ),
    expected: receipt({
      items: [item('Steak', 4200), item('Salmon', 2800)],
      subtotalCents: 7000,
      taxCents: 613,
      feesCents: 1260,
      totalCents: 8873,
    }),
  },
  {
    name: 'card-slip-noise',
    text: linesOf(
      'BISTRO EXAMPLE',
      '11/20/2026 7:45 PM',
      '(555) 010-0199',
      'Server: Sam',
      'Table 12',
      'Guests: 2',
      'Check #4821',
      'Club Sandwich 13.50',
      'Soup 6.00',
      'Subtotal 19.50',
      'Tax 1.56',
      'Total 21.06',
      'VISA XXXX1234',
      'Auth 012345',
      'Card **1234 21.06',
      'Tip 4.00',
      'Total 25.06',
      'Thank you',
    ),
    expected: receipt({
      items: [item('Club Sandwich', 1350), item('Soup', 600)],
      subtotalCents: 1950,
      taxCents: 156,
      tipCents: 400,
      totalCents: 2506,
    }),
  },
  {
    name: 'vision-columns',
    text: visionColumns,
    expected: visionExpected,
  },
  {
    name: 'does-not-add-up-1c',
    text: linesOf('Club Salad 10.00', 'Fruit Cup 5.01', 'Subtotal 15.00', 'Tax 1.20', 'Total 16.20'),
    expected: receipt({
      items: [item('Club Salad', 1000), item('Fruit Cup', 501)],
      subtotalCents: 1500,
      taxCents: 120,
      totalCents: 1620,
    }),
  },
  {
    name: 'does-not-add-up',
    text: linesOf('Club Salad 10.00', 'Fruit Cup 5.02', 'Subtotal 15.00', 'Tax 1.20', 'Total 16.20'),
    expected: receipt({
      items: [item('Club Salad', 1000), item('Fruit Cup', 502)],
      subtotalCents: 1500,
      taxCents: 120,
      totalCents: 1620,
      reasons: ['items_vs_subtotal'],
    }),
  },
  {
    name: 'missing-total',
    text: linesOf('Bagel 3.50', 'Coffee 2.75', 'Subtotal 6.25', 'Tax 0.50'),
    expected: receipt({
      items: [item('Bagel', 350), item('Coffee', 275)],
      subtotalCents: 625,
      taxCents: 50,
      reasons: ['missing_total'],
    }),
  },
  { name: 'vision-tilted', text: visionTilted, expected: visionExpected },
  {
    // A2.2: a discount directly under an item folds into it; its text becomes part of the note.
    name: 'item-discount',
    text: linesOf(
      'Burger 12.00',
      'Happy Hour -2.00',
      'Happy Hour Wings 8.00',
      'Comp Salad 0.00',
      'Subtotal 18.00',
      'Tax 1.44',
      'Total 19.44',
    ),
    expected: receipt({
      items: [
        item('Burger', 1000, { modifiers: ['Happy Hour'] }),
        item('Happy Hour Wings', 800),
        item('Comp Salad', 0),
      ],
      subtotalCents: 1800,
      taxCents: 144,
      totalCents: 1944,
    }),
  },
  {
    // Real OCR: three of four items (Tesseract lost the Causa price), "Total Taxes" as tax, the
    // tip guide ignored. The missing item shows as an items-vs-subtotal gap for the host to fix.
    name: 'tesseract-el-chalan',
    text: tesseractElChalan,
    expected: receipt({
      items: [item('CEVICHE DE CAMARONES', 1695), item('LIMONADA', 400), item('PESCADO AL AJILLO', 1595)],
      subtotalCents: 4585,
      taxCents: 367,
      totalCents: 4952,
      reasons: ['items_vs_subtotal'],
    }),
  },
  {
    // Real OCR: qty before the name, a menu number kept in the name, a glued price. The total is
    // missing only because Tesseract read "57.71" as "57.1"; "Pay With Cash" is never the total.
    name: 'tesseract-la-cabana',
    text: tesseractLaCabana,
    expected: receipt({
      items: [
        item('Dos Tacos (Brunch)', 1800),
        item('6. Taco y Enchilada (Super Combo)', 2195),
        item('Brunch Reg Lime Margarita', 1275),
      ],
      subtotalCents: 5270,
      taxCents: 501,
      reasons: ['missing_total'],
    }),
  },
  {
    // The El Chalan receipt as printed (what a perfect read would give).
    name: 'el-chalan-as-printed',
    text: linesOf(
      'El Chalan Restaurant',
      'TABLE: 13 - 1 Guest',
      'Your Server was Sam',
      '3/12/2016 1:13:51 PM',
      'Sequence #: 0000068',
      'ID #: 0389450',
      'ITEM QTY PRICE',
      'CAUSA DE POLLO 1 $8.95',
      'CEVICHE DE CAMARONES 1 $16.95',
      'LIMONADA 1 $4.00',
      'PESCADO AL AJILLO 1 $15.95',
      'Subtotal $45.85',
      'Total Taxes $3.67',
      'Grand Total $49.52',
      'Amount Due: $49.52',
      '15% 20% 25%',
      '$7.43 $9.90 $12.38',
      'TIP IS NOT INCLUDED',
      'THANK YOU - GRACIAS!!!',
    ),
    expected: receipt({
      items: [
        item('CAUSA DE POLLO', 895),
        item('CEVICHE DE CAMARONES', 1695),
        item('LIMONADA', 400),
        item('PESCADO AL AJILLO', 1595),
      ],
      subtotalCents: 4585,
      taxCents: 367,
      totalCents: 4952,
    }),
  },
  {
    // The La Cabana receipt as printed.
    name: 'la-cabana-as-printed',
    text: linesOf(
      'La Cabana - Venice',
      'Opened: 03/10/2024 1:06 pm',
      'Order: 1809 Check: 1',
      'Order Type: Dine In',
      'Name: Table 15',
      'Server: Sam',
      '1 Dos Tacos (Brunch) 18.00',
      '1 6. Taco y Enchilada (Super Combo)21.95',
      '1 Brunch Reg Lime Margarita 12.75',
      'Subtotal 52.70',
      'Sales Tax 5.01',
      'Total 57.71',
      'Pay With Cash: 55.49',
      'Customer copy',
      'Thank you!',
    ),
    expected: receipt({
      items: [
        item('Dos Tacos (Brunch)', 1800),
        item('6. Taco y Enchilada (Super Combo)', 2195),
        item('Brunch Reg Lime Margarita', 1275),
      ],
      subtotalCents: 5270,
      taxCents: 501,
      totalCents: 5771,
    }),
  },
  {
    // Real web OCR: the stray "4" before the name is not the qty, because the ITEM QTY PRICE header
    // puts the qty after the name. "RTE" (the misread qty column) stays in the name for the host.
    name: 'tesseract-el-chalan-web',
    text: tesseractElChalanWeb,
    expected: receipt({
      items: [
        item('CAUSA DE POLLO RTE', 895),
        item('CEVICHE DE CAMARONES', 1695),
        item('LIMONADA', 400),
        item('PESCADO AL AJILLO', 1595),
      ],
      subtotalCents: 4585,
      taxCents: 367,
      totalCents: 4952,
    }),
  },
  {
    // Real web OCR: "09:19PM Tota) 126.37" is the total, and the Gratuity line that the row
    // grouping joined to it is the tip. "607 FILET" is "6OZ FILET" with "OZ" read as "07", so it
    // is repaired to "6oz FILET"; other OCR damage in the names is left for the host.
    name: 'tesseract-raintree-web',
    text: tesseractRaintreeWeb,
    expected: receipt({
      items: [
        item('6oz FILET', 2600),
        item('MAHI', 2600),
        item('S08 Cup BIsOuE', 300),
        item('CUP BISQUE', 500),
        item('SUB HOUSE SALAD', 200),
        item('REESES COOKIE', 700),
        item('GL PINOT GRIGIO', 1600, { qty: 2, unitCents: 800 }),
        item('RAINTREE Rupy', 1000),
        item('NUTTY IRISH ICE', 900),
      ],
      subtotalCents: 10400,
      taxCents: 677,
      tipCents: 1560,
      totalCents: 12637,
    }),
  },
];

export function getFixture(fixtureName: string): ReceiptFixture {
  const f = receiptFixtures.find((x) => x.name === fixtureName);
  if (!f) throw new Error(`No receipt fixture named ${fixtureName}`);
  return f;
}
