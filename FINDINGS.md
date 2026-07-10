# Relevance evaluation — findings

The search stack is evaluated by a labeled benchmark (the **Relevance evals** tab
in the app, `web/app/evals`). It measures two things:

1. **Intent accuracy** — does the intent agent map a natural-language question to
   the correct structured criteria, and does it flag the asks the data can't
   answer? Scored against gold labels: precision / recall / F1 + exact-match, plus
   "gap-flag recall" (did it flag the expected unavailable signals).
2. **Result relevance** — an independent **LLM-as-judge** scores (0–5) whether the
   actually-returned properties are relevant to the question, accounting for the
   documented proxy/gap limits.

Benchmark: 11 questions (`web/lib/evals.ts`) covering each signal, synonyms
("coffee shop" → Starbucks), multi-condition queries, the sale-date proxy, and the
owner data-gap.

## Headline results

| Metric | Before fix | After fix |
|---|---|---|
| Intent exact-match | 100% | 100% |
| Criteria F1 | 1.00 | 1.00 |
| Gap-flag recall | 86% | **100%** |
| Pass rate | 82% | **100%** |
| Avg judge relevance | 3.7 / 5 | **4.0 / 5** |

## What the eval caught (and we fixed)

**1. Unanswerable questions returned everything.**
"Which properties have out-of-area owners?" maps *only* to an unsupported signal
(owner mailing address isn't free open data). The query builder had no criteria and
fell back to `WHERE TRUE`, returning **all 500** properties. The LLM judge caught it
(**1/5** relevance). Fix: when the only asks are unsupported, the query returns
`WHERE FALSE` (0 rows) and the UI shows the documented gap. After fix the same case
scores **5/5** and returns **0 rows**. (`web/lib/intent.ts`)

**2. The sale-date proxy wasn't always disclosed.**
"Properties that have not sold in 10 years" correctly used the permit-dormancy
proxy, but didn't always *flag* that true sale dates are unavailable. The intent
prompt now requires flagging `exact_sale_date` on any "sold/sale" question. Gap-flag
recall rose 86% → 100%. (`web/app/api/intent/route.ts`)

## Observations / limits

- The judge is deliberately strict. "Recently re-roofed" scores ~2–4/5 because the
  question is a weaker match to the available signal (absence-of-old-roof vs. an
  explicit recent-reroof intent) — a fair penalty, not a bug.
- The benchmark scores the LLM intent step (where variance lives). The SQL is
  deterministic from the parsed intent, so retrieval itself is exact by
  construction — the eval focuses effort where errors actually occur.
- Runtime: ~11 questions × (1 intent call + 1 judge call) ≈ 90–110 s. Uncheck
  "LLM-as-judge" to score intent only, with no Anthropic calls for the judge.

## Reproduce

Open **Relevance evals** in the app and click **Run benchmark**, or read the cases
and scoring in `web/lib/evals.ts` and the judge in `web/app/api/eval/route.ts`.
