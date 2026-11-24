# Fixed synthetic rebuttal evaluation — 32 cases

Model: existing luna-medium profile, gpt-5.6-luna, medium reasoning.
Runner: a local CLI runner calls actual Codex CLI through run_analysis.
Only synthetic inputs; no private reviews/manuscripts or authentication contents read/copied.
Fixture SHA256: 27e0ca9b8ba77f4921653a10cbffbb4df06a8a6b2fcf63a48eb4de2b3afc0549.
Fixture and expected outputs were frozen during this complete 32-case run.

| Metric | Actual result |
| --- | --- |
| True mapping edges | 42 |
| False mapping edges | 0 |
| Missed expected mapping edges | 2 |
| Mapping precision | 1.0000 |
| Mapping recall | 0.9545 |
| Exact sufficiency labels | 28 / 36 (0.7778) |
| Overclaimed addressed (gold partial/related/missing) | 0 |
| Expected addressed, actual partial | 7 |
| Expected addressed, actual missing | 1 |
| Runner/quote/ID validation failures | 0 |

The seven partial judgments are conservative mismatches, not false completion claims.
The one missing judgment is synthetic-24-dataset/c1 and accounts for both missed
mapping edges (d1 and d2). Critical is defined here as overclaimed completion or
runner/grounding validation failure; no such critical input exists to quote.

## Missed concern original synthetic input

Review r1: Please explain dataset evidence and limitations.

Review r2: What supports the dataset claim?

Concern c1: dataset evidence
Source spans: [{"review_id": "r1", "field": "review", "quote": "dataset evidence"}]

Concern c2: Support for dataset
Source spans: [{"review_id": "r2", "field": "review", "quote": "dataset claim"}]

Response d1: We report the dataset experiment with three seeds.

Response d2: The dataset experiment is limited to one benchmark.

Expected c1: addressed, linked to d1 and d2. Actual c1: missing, no links.
Expected c2: addressed. Actual c2: partial.

No fixture or expected label was changed in response to this complete run.
No prompt/validator adjustment was made after it: no overclaimed addressed or
structural failure was observed. Existing 22 scoped unit tests remain valid;
no repeated test run was needed because code did not change.

Limits: one model/profile, synthetic mapping/sufficiency cases only. This CLI
runner does not measure HTTP deployment integration, live translation/extraction,
rule research quality, or real private manuscript performance. Mock-32 results
are separate structural evidence and must not be cited as live quality results.
