# Bounded Harness²-inspired adaptation

Primary reference: [google-research/harness2](https://github.com/google-research/harness2), specifically fixed-model **Propose–Probe–Compose** and a persistent evidence/lesson library. This independent implementation narrows the idea to browser selector and timing configuration; it is not upstream Harness², an autonomous model editor, or model training.

## Run the local proof

```sh
skill self-improve --demo --output artifacts/self-improvement
```

The demo launches an owned loopback page and real Chromium. A deliberately obsolete selector fails; a candidate selector retrieves a synthetic fixture value. It then proposes a timeout change that cannot solve the slower fixture and rejects its tied score. Baseline/candidate runs use the same immutable case IDs, separate fresh executions, and real elapsed-time observations. No provider accounts or paid model calls occur.

Demo time weight is explicitly zero to keep the tied-score rejection independent of timing jitter. General evaluations default to `successRate=100`, `medianTimeToKeySeconds=1`, `humanInterventions=10`.

## Embedding

Import `runCycle` and its named contracts from `rsi/loop.ts` (built package: `dist/rsi/loop.js`). Initialize `<workspace>/rsi/harness.json` with exactly `selector`, `timeoutMs`, and `paceMs`. Supply case IDs and an evaluator that actually executes each case and returns its success, elapsed milliseconds, human interventions, and optional selector/timeout/pace failure evidence. The evaluator is trusted code: use nonsecret local fixtures, not live provider signups or model configuration.

A cycle reads the last N persisted failures (`historyLimit`, default 20). Matching historical suggestions may fill missing evidence only for the same case and exact harness configuration. Every proposal still requires a fresh baseline and candidate evaluation; historical metrics never substitute for probe results. Failure history is bounded and its snapshot is copied into each run's evidence.

## Score and promotion

`score = success_rate*w1 - median_time_to_key_seconds*w2 - human_interventions*w3`.

When no case succeeds, elapsed failure times are used as the time penalty rather than inventing a zero time-to-key. Relative gain is `(candidate - baseline) / max(abs(baseline), Number.EPSILON)`; a zero baseline therefore has a well-defined positive-improvement gate, not a meaningful percent estimate.

Promotion requires **strictly greater than 2% relative gain**, no lost previously successful case, no aggregate success-rate reduction, and no score regression. A rejected candidate never overwrites even the original harness's whitespace. Only one field changes per candidate.

Hard limits:

- At most five candidates per cycle.
- At most three consecutive promotions of the same field, across cycles.
- Hard stop after three cumulative regressions; later cycles do not evaluate again.
- Invalid result sets/configuration/safety history fail closed.
- The local harness must remain unchanged during probing, or promotion is refused.

Each promotion appends `rsi/CHANGELOG.md` in the workspace, including old/new field values, scores/delta, rationale, and the probe evidence path. `runs/` contains paired results, decision JSON, telemetry, and screenshots for the supplied browser evaluator. Persistent guardrails are separate from tunable harness fields. Model configuration/weights, secrets, identity, recipes, core source, and quota state are never candidate fields.
