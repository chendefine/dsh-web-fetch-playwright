# Benchmark protocol

How the denoise pipeline's learned models are trained and how changes are
judged, so that benchmark numbers stay honest estimates instead of numbers
the code was tuned to. The tooling lives in `benchmark/` (not shipped; see
`docs/web-content-extraction-benchmarks.md` for the datasets).

## Splits and what each may be used for

| Split | Pages | Role | May train on it | May tune or gate on it |
|---|---|---|---|---|
| WCXB dev | 1,497 | training + development | yes | yes, by 5-fold grouped CV |
| ScrapingHub | 181 | training + development | yes | yes, by CV |
| trafilatura | 990 | training (selector only) + development | yes | yes, by CV |
| WCXB test | 511 | held out | **never** | **no**: scored once per release, for the record |
| `fc` (Firecrawl snapshot) | ≈850 | sealed, multilingual | **never** | **no**: scored once per release, for the record |

`train-selector.py` refuses `--train wcxb-test=…` and `--train fc=…`.

`fc` is Firecrawl scrape-content-dataset-v1 rendered once by
`benchmark/snapshot-firecrawl.mjs` with the provider's own render steps
(domcontentloaded, ≤5s network idle, deep-capture walk, script strip) and
frozen as gzipped HTML next to the dataset's human truth text. It is the only
labeled split with Chinese and Japanese pages, so it is reported overall and
for its CJK and non-CJK halves. Its scorer is WCXB's word F1 with a CJK-aware
tokenizer (each Han or kana character is one token, matching `src/blocks.ts`).
The snapshot was taken months after the truth text was written, so absolute
scores include page drift; compare versions on the same snapshot only.

## Rules

1. **Decide on development data.** Accept or reject a change by its
   cross-validated effect on the training splits. Do not look at WCXB test
   or `fc` to decide whether a change ships, which threshold to pick, or
   which badcase to chase next.
2. **Report held-out numbers once per release.** Score WCXB test and `fc`
   after the change is final and record them in the CHANGELOG. If a held-out
   number then disappoints, that is a finding to report, not a reason to
   iterate against the same split.
3. **No site-specific rules.** A heuristic may not key on a hostname, a
   site's own class names or abbreviations, or one platform's URL codes.
   Platform knowledge is allowed only where the page declares it (generator
   meta, a platform's documented data island) or where a vendor name is used
   by thousands of unrelated sites (Outbrain, Taboola, OneTrust). Badcases
   are reduced to their page shape and tested as that shape.
4. **Retrain when features change.** Any change to tokenization, a feature's
   definition, or candidate generation regenerates both models: block
   classifier first (`train-blocks.py --export … --folds …`), then the
   selector on candidate dumps that use the cross-fitted block models
   (`BLOCK_FOLDS`), so the selector never trains on in-fold block
   predictions.
5. **Hand-set thresholds get a sensitivity check.** When a heuristic's
   constant is introduced or changed, re-run development scores with it at
   ×0.75 and ×1.25. A result that only holds at the chosen value is tuned to
   the data and must be reworked.
6. **Retire a held-out split after heavy reuse.** Once a held-out split has
   been reported for several releases, treat it as development data and
   freeze a new sealed snapshot.
