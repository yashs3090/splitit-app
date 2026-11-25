# LLM structured extraction

> **Status: shelved fallback (2026-11-20).** SplitIt does **not** use Claude right now. Receipts are read on the device and parsed by our own `lib/receiptText.ts` ([ADR 0010](../decisions/0010-on-device-ocr-no-custom-backend.md), [on-device OCR](on-device-ocr.md)). This note describes the fallback if parser accuracy stays under 85%: Claude in a Supabase Edge Function. That would bring back custom server code and a per-scan cost, so it's the user's decision. The validation ideas below (schema first, totals check, human review, measure with the eval) apply to our own parser too.

## The idea
A large language model with vision can read a photo of a receipt the way a person does. **Structured outputs** force its answer to match a JSON schema we define. Instead of free text we get an object we can parse and store directly.

```ts
// Sketch only, not built (would live in supabase/functions/parse-receipt)
const response = await client.messages.create({
  model: "claude-opus-5-5",
  max_tokens: 16000,
  output_config: { effort: "low", format: { type: "json_schema", schema: receiptSchema } },
  messages: [{ role: "user", content: [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
    { type: "text", text: "Extract every line item from this receipt. Amounts in integer cents…" },
  ]}],
});
```
Exact SDK details are checked against the Anthropic docs when it's built; this only shows the shape.

## Why it matters here
Receipts vary wildly: abbreviations ("CHKN SNDWCH"), modifiers ("+ avocado 2.00"), quantities, discounts, service charges, multiple taxes. Rule-based OCR parsing breaks on every new layout. One prompt and a schema handle photos, PDFs and web-page text.

## Design rules we follow
1. **Schema first.** It includes merchant, currency, items (name, qty, unit and total cents), subtotal, tax, tip, service charge, discounts and total. Fields that might be missing (e.g. tip) are nullable rather than guessed.
2. **Validate after.** A schema guarantees the *shape*, not the *truth*. Check that the items add up to the subtotal, and that subtotal − discounts + tax + tip + fees = total (±1¢). If not, the host reviews the bill instead of trusting it.
3. **Humans stay in the loop.** The host can always edit lines before sharing.
4. **Measure, don't guess.** Keep `parse_runs`, and run the receipt eval (`/receipt-eval`) before changing the prompt or model.
5. **Treat the content as untrusted.** Text on a receipt or web page is data, never instructions. The prompt says so, and the only thing the output can do is fill our schema.
6. **Cost awareness.** Image size drives input tokens. Resize to about 1600px on the long side before upload.

## Pitfalls
- Asking for dollars as floats. Ask for integer cents.
- No validation, so a misread "8" for "3" flows straight into what people owe.
- Changing the prompt without re-running the eval, which can quietly make accuracy worse.
- Calling the API from the client, which leaks the key.

## Check yourself
1. Structured outputs guarantee valid JSON. Why do we still validate?
2. What should happen when the totals don't reconcile?
3. How would you decide whether a cheaper model is good enough?

## Learn more
- https://docs.claude.com/en/docs/build-with-claude/structured-outputs
- https://docs.claude.com/en/docs/build-with-claude/vision
