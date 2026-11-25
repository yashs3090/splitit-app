# 0006: Claude with structured outputs for receipt parsing

**Status:** Superseded by [0010](0010-on-device-ocr-no-custom-backend.md) (2026-11-20). Previously Accepted (2026-11-19).

## Context
We need to turn a messy receipt photo, PDF or web page into clean line items, tax, tip and total.

## Options
| Option | Pros | Cons |
|---|---|---|
| Classic OCR (Google Cloud Vision text detection) | Cheap (~$1.50 per 1,000 images after the free tier) | Returns raw text with positions only: we'd write fragile parsing rules per receipt layout |
| Receipt-specific API (AWS Textract AnalyzeExpense) | Returns structured fields | ~$0.01/page (third-party figures, unverified); images only, so it doesn't help with receipt web pages; less flexible |
| **LLM with vision + structured outputs (Claude)** | Reads photos, PDFs *and* web-page text with one prompt; handles modifiers ("+ avocado"), abbreviations and discounts; output is forced to match our JSON schema | Costs more per call (estimated ~$0.04 on Opus 5.5, ~$0.001 on Haiku 5.5); can still misread, so we validate |

## Decision
Call Claude from a Supabase Edge Function using `@anthropic-ai/sdk`, with `output_config.format` set to a JSON schema of our receipt shape. Default model `claude-opus-5-5`. A cheaper model is only adopted if the receipt eval shows equal accuracy. That's the user's call.

## Consequences
- Never trust the model blindly: validate that items add up to the subtotal and that subtotal + tax + tip − discounts = total. If not, the host reviews.
- The API key stays server-side, so the client calls our Edge Function, never Anthropic directly.
- We keep every parse result (`parse_runs`) so we can debug and build an eval set.

See [llm-structured-extraction](../concepts/llm-structured-extraction.md).
