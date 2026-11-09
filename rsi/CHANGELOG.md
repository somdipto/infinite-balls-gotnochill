# Harness improvement evidence

Implementation and guardrails: [self-improvement guide](../docs/self-improvement.md).
Reference: [google-research/harness2](https://github.com/google-research/harness2).

## Isolated browser evaluation

A real Chromium fixture run adopted `selector: "#obsolete-credential" → "#credential"`, with score `0 → 66.66666666666666`. Two of three identical eval cases then succeeded. A subsequent `timeoutMs: 500 → 1000` candidate tied its baseline score and was rejected; adopted timeout remained 500. Model weights and provider credentials were untouched.

[Observed decision evidence](../docs/evidence/improvement.json). This entry records the isolated verification workspace, not a production account flow. Each runtime promotion appends its own field diff, score delta, rationale, and evidence path to `<workspace>/rsi/CHANGELOG.md`; raw screenshots/results remain in that workspace's `runs/`.
