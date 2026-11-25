# Receipt answers: telling the eval what each receipt really says

The receipt eval (`npm run eval`) measures how well the app reads receipts. It compares the app's
read of each photo with an **answer file** you write: the correct items and totals, typed the way
the receipt reads, in dollars.

Everything here stays on your machine. `receipts/` (photos and `receipts/answers/`) and
`eval/receipts/` are gitignored because receipts can carry names and card digits.

## The 5 steps

1. **Add the photo** to `receipts/` (JPEG, PNG or WebP; HEIC can't be read in the browser).
2. **Let the app read it:** `npm run ocr:harness -- --variants web-current`
3. **Make the drafts:** `npm run answers:draft`
   This writes `receipts/answers/<photo name>.txt` for every photo that has no answer file yet,
   pre-filled with what the app read, ending in `checked: no`. It never overwrites an answer file.
4. **Fix the draft** with the photo open: correct the names, quantities and prices, add missed
   items, delete junk lines, fill in the totals. When it matches the photo, change the last line to
   `checked: yes`.
5. **Check, then score:** `npm run answers:check` (fast; lists checked / draft / missing, any
   mistakes in the files, and whether each answer adds up), then `npm run eval`.

Only answers with `checked: yes` are scored. Drafts are skipped, so the app is never graded
against its own guess.

## What an answer file looks like

`receipts/answers/la-cabana.txt` for the photo `receipts/la-cabana.jpeg`:

```
# lines starting with # are comments
1  Dos Tacos (Brunch)                18.00
1  6. Taco y Enchilada (Super Combo) 21.95
5  Cape Town Margarita               90.00

subtotal  129.95
tax       5.01
tip       -
fees      3.60
total     138.56

checked: yes
```

### Rules

- **Item line:** quantity, then name, then the line's price. The quantity is a whole number
  (`1`, `5`). The price is what that whole line costs, including paid add-ons, with exactly two
  decimals (`18.00`, not `18` or `18.0`). A `$` is optional, and so are commas (`1,234.50`).
  Spacing doesn't matter. Numbers inside the name are fine (`6. Taco y Enchilada`); only the last
  thing on the line is read as the price.
- **Totals:** `subtotal`, `tax`, `tip`, `fees` (service charges) and `total`. Write the amount, or `-`
  (or nothing) if the receipt doesn't print it. `0.00` means "printed as zero", which is not the
  same as `-`. Several tax lines? Write one `tax` line for each and they're added up (same for
  `fees`).
- **Discounts:** one line each, written as a positive amount (a printed `-2.00` is fine too).
  - `discount 2.00` comes off the **total**: subtotal + tax + tip + fees - discount = total.
  - `discount before subtotal 2.00` comes off the **items**: items - discount = subtotal.
  - An optional label goes before the amount: `discount before subtotal Happy hour 2.00`.
- **`checked: yes`** marks it ready. Leave it out or write `checked: no` while it's a draft.
- Lines starting with `#` are ignored.

`npm run answers:check` names the file and line of any mistake, for example
`receipts/answers/la-cabana.txt line 4: price must look like 12.50 (two decimals); got "12.5"`.
It also says when an answer doesn't add up (items vs subtotal, subtotal + extras vs total), using
the same rule as the app: each check may be off by 1¢ (rounding), not more. That's usually a typo,
but if the receipt really doesn't add up, you can still mark it checked.

## Other options

- Redo one draft from the app's latest read: `npm run answers:draft -- --force la-cabana.jpeg`.
  The old file is kept next to it as `la-cabana.txt.<time>.bak`.
- A photo the app can't read at all: `npm run answers:draft -- --blank` writes an empty draft to type in.
- A photo you already looked at while tuning the parser (so it mustn't be in the held-out set):
  add `--used-before-split <photo>` the **first** time you draft it.

## Comparing scan settings (added 2026-11-25)

The harness can read the photos with any setup listed in `VARIANTS` (`lib/scanPipeline/config.ts`), for
example `web-current` (what the app does today) and `web-crop-canvas` (crop to the receipt first).
Each read is saved as `eval/receipts/<name>.<variant>.ocr.json`.

```sh
npm run ocr:harness -- --variants web-current,web-crop-canvas   # read every photo both ways
npm run ocr:harness -- --variants web-current --only la-cabana  # one photo
npm run eval -- --variant web-crop-canvas                       # score one setup
npm run eval -- --compare web-current,web-crop-canvas --core    # is the crop at least no worse?
npm run eval -- --compare web-crop-canvas,web-crop-th40         # does the extra step gain enough?
npm run eval -- --flow web-current,web-crop-th40                # today's read, then a retry if it fails
npm run eval -- --compare web-current,web-crop-canvas --confirm # also show held-out, once
```

- The harness runs the app's own web scan code in a headless Chromium on `127.0.0.1` only. The first
  run needs `npx playwright install chromium` (a browser download of roughly 100–200 MB, unverified).
  It never uploads or copies a photo.
- Setups that use OpenCV build their own private copy of it for the run, so they work even while the
  app has OpenCV switched off.
- `--compare` prints ADOPT or REJECT with the reason. With fewer than 12 tuning and 8 held-out checked
  answers, the verdict is marked PROVISIONAL.
- **Run `--confirm` once per experiment, after you've chosen on tuning.** Looking at held-out, changing
  something and looking again turns held-out into tuning. Why this matters:
  [the scan pipeline note](../learning/concepts/scan-pipeline.md#how-the-decisions-were-made).

## Tuning and held-out sets (you don't edit these)

Each receipt is in the **tuning** set (used while improving the reader) or the **held-out** set
(kept aside to confirm a change really helps). The set comes from a hash of the photo's name, so
nobody picks it. Receipts seen before the split are always tuning. The set is recorded once, by
`answers:draft`, in `eval/receipts/sets.json`. It is kept out of the answer file so editing an
answer can't move a receipt between sets, and no tool ever changes a recorded set. The eval only
scores a checked answer once its set is recorded; until then it says "set not recorded yet" and
skips it (run `npm run answers:draft` to record it). An answer file with mistakes in the held-out
set is named without its details until `--confirm`; `answers:check` shows the details.

## Old format

Before answer files, ground truth was `eval/receipts/<name>.expected.json` in cents.
`answers:draft` moves each one into a `.txt` with the same values (and keeps `checked` if it was
checked). The old files are left in place, but the eval only reads one when a photo has no `.txt`.
`scripts/eval-init.ts` is retired and points here.
