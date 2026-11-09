import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCycle } from '../rsi/loop.js';
import type { CaseResult, CycleOptions, Evaluator, GuardrailState, HarnessConfig } from '../rsi/loop.js';

const INITIAL: HarnessConfig = { selector: '#old', timeoutMs: 100, paceMs: 0 };
const CASES = [{ id: 'one' }];
async function fixture(action: (workspace: string, bytes: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'freeapi-rsi-test-'));
  const bytes = '{ "selector": "#old", "timeoutMs": 100, "paceMs": 0 }\n';
  try {
    await mkdir(join(workspace, 'rsi'));
    await writeFile(join(workspace, 'rsi', 'harness.json'), bytes);
    await action(workspace, bytes);
  } finally { await rm(workspace, { recursive: true, force: true }); }
}
function failed(caseId: string, elapsedMs = 100): CaseResult {
  return { caseId, success: false, elapsedMs, humanInterventions: 0, failure: { kind: 'selector', message: 'Old selector is absent', selectorFallback: '#new' } };
}
const promoteSelector: Evaluator = async ({ harness, cases }) => cases.map(item => harness.selector === '#old' ? failed(item.id) : {
  caseId: item.id, success: true, elapsedMs: 100, humanInterventions: 0,
});

test('promotes a single failure-driven field and persists real evaluator evidence', async () => {
  await fixture(async workspace => {
    const calls: { phase: string; cases: readonly { id: string }[]; selector: string }[] = [];
    const result = await runCycle({ workspace, cases: CASES, maxMutations: 1, evaluate: async input => {
      calls.push({ phase: input.phase, cases: input.cases, selector: input.harness.selector });
      return promoteSelector(input);
    } });
    assert.equal(result.probes[0]?.outcome, 'promoted');
    assert.equal(result.final.selector, '#new');
    assert.equal(result.final.timeoutMs, INITIAL.timeoutMs);
    assert.equal(result.state.sameFieldPromotions, 1);
    assert.deepEqual(calls.map(call => call.phase), ['baseline', 'candidate']);
    assert.equal(calls[0]?.cases, calls[1]?.cases);
    assert.notEqual(calls[0]?.selector, calls[1]?.selector);
    const changelog = await readFile(join(workspace, 'rsi', 'CHANGELOG.md'), 'utf8');
    assert.match(changelog, /#old.*#new/);
    assert.ok(changelog.includes(result.probes[0]!.evidencePath));
    const saved: unknown = JSON.parse(await readFile(join(result.evidencePath, 'telemetry.json'), 'utf8'));
    assert.ok(saved);
  });
});

test('a tied score rejects without changing even harness whitespace', async () => {
  await fixture(async (workspace, bytes) => {
    const evaluate: Evaluator = async ({ cases }) => cases.map(item => failed(item.id));
    const result = await runCycle({ workspace, cases: CASES, evaluate, maxMutations: 1 });
    assert.equal(result.probes[0]?.outcome, 'rejected');
    assert.equal(result.state.regressions, 0);
    assert.equal(await readFile(join(workspace, 'rsi', 'harness.json'), 'utf8'), bytes);
  });
});

test('requires strictly greater than two percent relative gain', async () => {
  await fixture(async (workspace, bytes) => {
    const result = await runCycle({
      workspace, cases: CASES, maxMutations: 1,
      weights: { successRate: 1, medianTimeToKeySeconds: 1, humanInterventions: 0 },
      evaluate: async ({ harness }) => [failed('one', harness.selector === '#old' ? 100_000 : 98_000)],
    });
    assert.equal(result.probes[0]?.relativeGain, 0.02);
    assert.equal(result.probes[0]?.outcome, 'rejected');
    assert.equal(await readFile(join(workspace, 'rsi', 'harness.json'), 'utf8'), bytes);
  });
});

test('handles zero and negative baseline scores without dividing by a signed baseline', async () => {
  await fixture(async workspace => {
    const result = await runCycle({ workspace, cases: CASES, maxMutations: 1, evaluate: promoteSelector,
      weights: { successRate: 100, medianTimeToKeySeconds: 0, humanInterventions: 0 } });
    assert.equal(result.baseline?.score, 0);
    assert.equal(result.probes[0]?.outcome, 'promoted');
    assert.ok(Number.isFinite(result.probes[0]?.relativeGain));
  });
  await fixture(async workspace => {
    const result = await runCycle({ workspace, cases: CASES, maxMutations: 1,
      evaluate: async ({ harness }) => [failed('one', harness.selector === '#old' ? 1000 : 500)],
      weights: { successRate: 100, medianTimeToKeySeconds: 1, humanInterventions: 0 } });
    assert.equal(result.baseline?.score, -1);
    assert.equal(result.probes[0]?.relativeGain, 0.5);
    assert.equal(result.probes[0]?.outcome, 'promoted');
  });
});

test('a lost successful case vetoes a higher aggregate score', async () => {
  await fixture(async (workspace, bytes) => {
    const result = await runCycle({ workspace, cases: [{ id: 'one' }, { id: 'two' }, { id: 'three' }], maxMutations: 1,
      weights: { successRate: 100, medianTimeToKeySeconds: 0, humanInterventions: 0 },
      evaluate: async ({ harness, cases }) => cases.map((item, index) => ({
        ...failed(item.id), success: harness.selector === '#old' ? index === 0 : index !== 0,
      })),
    });
    assert.ok(result.probes[0]!.candidate!.score > result.probes[0]!.baseline.score);
    assert.equal(result.probes[0]?.outcome, 'rejected');
    assert.equal(result.state.regressions, 1);
    assert.equal(await readFile(join(workspace, 'rsi', 'harness.json'), 'utf8'), bytes);
  });
});

test('at most five mutations are probed per cycle, with fresh paired runs', async () => {
  await fixture(async workspace => {
    let calls = 0;
    const cases = Array.from({ length: 8 }, (_, index) => ({ id: `case-${index}` }));
    const result = await runCycle({ workspace, cases, evaluate: async () => {
      calls += 1;
      return cases.map((item, index) => ({ ...failed(item.id), failure: { kind: 'selector', message: 'Different possible fallback', selectorFallback: `#fallback-${index}` } }));
    } });
    assert.equal(result.probes.length, 5);
    assert.equal(calls, 10);
    assert.equal(result.stopReason, 'mutation-budget');
  });
});

test('three same-field promotions persist across cycles and block a fourth', async () => {
  await fixture(async workspace => {
    const evaluate: Evaluator = async ({ harness }) => [{
      caseId: 'one', success: false, elapsedMs: 100_000 / harness.timeoutMs, humanInterventions: 0,
      failure: { kind: 'timeout', message: 'Observed timeout', suggestedMs: harness.timeoutMs + 100 },
    }];
    for (let index = 0; index < 3; index += 1) {
      const result = await runCycle({ workspace, cases: CASES, maxMutations: 1, evaluate });
      assert.equal(result.probes[0]?.outcome, 'promoted');
      assert.equal(result.state.sameFieldPromotions, index + 1);
    }
    const result = await runCycle({ workspace, cases: CASES, maxMutations: 1, evaluate });
    assert.equal(result.probes.length, 0);
    assert.equal(result.stopReason, 'no-proposal');
    assert.equal(result.state.sameFieldPromotions, 3);
    assert.equal(result.final.timeoutMs, 400);
  });
});

test('third cumulative regression hard-stops persisted state and later cycles never evaluate', async () => {
  await fixture(async (workspace, bytes) => {
    let calls = 0;
    const evaluate: Evaluator = async ({ harness }) => {
      calls += 1;
      return [failed('one', harness.selector === '#old' ? 100 : 200)];
    };
    for (let index = 0; index < 3; index += 1) {
      const result = await runCycle({ workspace, cases: CASES, maxMutations: 1, evaluate });
      assert.equal(result.state.regressions, index + 1);
    }
    assert.equal(calls, 6);
    const stopped = await runCycle({ workspace, cases: CASES, evaluate });
    assert.equal(calls, 6);
    assert.equal(stopped.stopReason, 'regression-limit');
    assert.equal(stopped.state.stopped, true);
    assert.equal(await readFile(join(workspace, 'rsi', 'harness.json'), 'utf8'), bytes);
  });
});

test('candidate exceptions count as regressions and retain baseline bytes', async () => {
  await fixture(async (workspace, bytes) => {
    const result = await runCycle({ workspace, cases: CASES, maxMutations: 1, evaluate: async input => {
      if (input.phase === 'candidate') throw new Error('Browser process failed');
      return [failed('one')];
    } });
    assert.equal(result.state.regressions, 1);
    assert.equal(result.probes[0]?.candidate, null);
    assert.match(result.probes[0]!.reason, /Browser process failed/);
    assert.equal(await readFile(join(workspace, 'rsi', 'harness.json'), 'utf8'), bytes);
  });
});

test('invalid candidate results are rejected rather than silently scoring a different case set', async () => {
  await fixture(async workspace => {
    const result = await runCycle({ workspace, cases: CASES, maxMutations: 1, evaluate: async input => [failed(input.phase === 'baseline' ? 'one' : 'other')] });
    assert.equal(result.probes[0]?.outcome, 'rejected');
    assert.equal(result.state.regressions, 1);
  });
});

test('unknown harness fields, corrupt safety state, and oversized budgets fail closed', async () => {
  await fixture(async workspace => {
    await writeFile(join(workspace, 'rsi', 'harness.json'), JSON.stringify({ ...INITIAL, model: 'forbidden' }));
    await assert.rejects(runCycle({ workspace, cases: CASES, evaluate: promoteSelector }), /only selector/);
    await writeFile(join(workspace, 'rsi', 'harness.json'), JSON.stringify(INITIAL));
    await writeFile(join(workspace, 'rsi', 'state.json'), '{}');
    await assert.rejects(runCycle({ workspace, cases: CASES, evaluate: promoteSelector }), /Invalid persisted/);
    const state: GuardrailState = { version: 1, cycles: 0, regressions: 0, lastPromotedField: null, sameFieldPromotions: 0, stopped: false };
    await writeFile(join(workspace, 'rsi', 'state.json'), JSON.stringify(state));
    const options: CycleOptions = { workspace, cases: CASES, evaluate: promoteSelector, maxMutations: 6 };
    await assert.rejects(runCycle(options), /1 to 5/);
  });
});

test('out-of-scope and unbounded failure suggestions cannot become mutations', async () => {
  await fixture(async (workspace, bytes) => {
    const result = await runCycle({ workspace, cases: CASES, evaluate: async () => [{
      ...failed('one'), failure: { kind: 'timeout', message: 'Unbounded suggestion', suggestedMs: 1_000_000 },
    }] });
    assert.equal(result.probes.length, 0);
    assert.equal(await readFile(join(workspace, 'rsi', 'harness.json'), 'utf8'), bytes);
  });
});

test('reuses bounded failure evidence only for the same case and exact harness', async () => {
  await fixture(async workspace => {
    await runCycle({ workspace, cases: CASES, historyLimit: 2, maxMutations: 1,
      evaluate: async ({ cases }) => cases.map(item => failed(item.id)) });
    const learned = await runCycle({ workspace, cases: CASES, historyLimit: 2, maxMutations: 1,
      evaluate: async ({ harness, cases }) => cases.map(item => harness.selector === '#new'
        ? { caseId: item.id, success: true, elapsedMs: 100, humanInterventions: 0 }
        : { ...failed(item.id), failure: { kind: 'selector', message: 'No fresh fallback available' } }) });
    assert.equal(learned.probes[0]?.outcome, 'promoted');
    assert.equal(learned.final.selector, '#new');
    const prior: unknown = JSON.parse(await readFile(join(learned.evidencePath, 'prior-failures.json'), 'utf8'));
    assert.ok(Array.isArray(prior) && prior.length === 2);
    const saved: unknown = JSON.parse(await readFile(join(workspace, 'rsi', 'failure-history.json'), 'utf8'));
    assert.ok(Array.isArray(saved) && saved.length <= 2);
    const differentCase = await runCycle({ workspace, cases: [{ id: 'unrelated' }], maxMutations: 1,
      evaluate: async () => [{ caseId: 'unrelated', success: false, elapsedMs: 100, humanInterventions: 0,
        failure: { kind: 'selector', message: 'No fallback for this case' } }] });
    assert.equal(differentCase.probes.length, 0);
  });
});
