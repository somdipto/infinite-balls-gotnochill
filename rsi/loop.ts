import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicWrite, readJson, withLock } from '../skill/files.js';
import { z } from 'zod';

/** A fixed-model, deterministic local Propose–Probe–Compose adaptation, not upstream Harness². */
export const IMPLEMENTATION = 'Harness2-inspired fixed-model local adaptation' as const;
export interface HarnessConfig { selector: string; timeoutMs: number; paceMs: number }
export type HarnessField = keyof HarnessConfig;
export interface EvaluationCase { readonly id: string }
export interface FailureEvidence {
  kind: 'selector' | 'timeout' | 'pace';
  message: string;
  selectorFallback?: string;
  suggestedMs?: number;
}
export interface CaseResult {
  caseId: string;
  success: boolean;
  elapsedMs: number;
  humanInterventions: number;
  failure?: FailureEvidence;
}
export interface EvaluationInput {
  readonly harness: Readonly<HarnessConfig>;
  readonly cases: readonly EvaluationCase[];
  readonly evidenceDir: string;
  readonly phase: 'baseline' | 'candidate';
}
/** Execute every supplied case anew; results must contain each case ID exactly once. */
export type Evaluator = (input: EvaluationInput) => Promise<readonly CaseResult[]>;
export interface ScoreWeights {
  successRate: number;
  medianTimeToKeySeconds: number;
  humanInterventions: number;
}
export interface CycleOptions {
  /** Only <workspace>/rsi/harness.json is mutable configuration. */
  workspace: string;
  cases: readonly EvaluationCase[];
  evaluate: Evaluator;
  /** Integer 1..5; persisted regression and field-streak limits cannot be relaxed. */
  maxMutations?: number;
  /** Maximum persisted failures considered for matching case/harness fallback evidence. */
  historyLimit?: number;
  weights?: ScoreWeights;
}
export interface Metrics {
  successRate: number;
  medianTimeToKeySeconds: number;
  humanInterventions: number;
  score: number;
}
export interface Mutation {
  field: HarnessField;
  before: string | number;
  after: string | number;
  rationale: string;
}
export interface ProbeResult {
  mutation: Mutation;
  outcome: 'promoted' | 'rejected';
  reason: string;
  baseline: Metrics;
  candidate: Metrics | null;
  relativeGain: number | null;
  evidencePath: string;
}
export interface GuardrailState {
  version: 1;
  cycles: number;
  regressions: number;
  lastPromotedField: HarnessField | null;
  sameFieldPromotions: number;
  stopped: boolean;
}
export interface CycleResult {
  implementation: typeof IMPLEMENTATION;
  runId: string;
  evidencePath: string;
  baseline: Metrics | null;
  final: HarnessConfig;
  probes: ProbeResult[];
  state: GuardrailState;
  stopReason: 'regression-limit' | 'no-proposal' | 'mutation-budget';
}
const DEFAULT_WEIGHTS: ScoreWeights = { successRate: 100, medianTimeToKeySeconds: 1, humanInterventions: 10 };
const FIELDS: readonly HarnessField[] = ['selector', 'timeoutMs', 'paceMs'];

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function harness(value: unknown): HarnessConfig {
  if (!object(value) || Object.keys(value).length !== 3 || Object.keys(value).some(key => !FIELDS.includes(key as HarnessField)) ||
      typeof value.selector !== 'string' || value.selector.length === 0 || value.selector.length > 512 ||
      !Number.isInteger(value.timeoutMs) || typeof value.timeoutMs !== 'number' || value.timeoutMs < 1 || value.timeoutMs > 30_000 ||
      !Number.isInteger(value.paceMs) || typeof value.paceMs !== 'number' || value.paceMs < 0 || value.paceMs > 5_000) {
    throw new Error('Harness must contain only selector (1..512 characters), timeoutMs (1..30000), paceMs (0..5000)');
  }
  return { selector: value.selector, timeoutMs: value.timeoutMs, paceMs: value.paceMs };
}
function guardrails(value: unknown): GuardrailState {
  if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.cycles) || typeof value.cycles !== 'number' || value.cycles < 0 ||
      !Number.isInteger(value.regressions) || typeof value.regressions !== 'number' || value.regressions < 0 || value.regressions > 3 ||
      !(value.lastPromotedField === null || FIELDS.includes(value.lastPromotedField as HarnessField)) ||
      !Number.isInteger(value.sameFieldPromotions) || typeof value.sameFieldPromotions !== 'number' || value.sameFieldPromotions < 0 || value.sameFieldPromotions > 3 ||
      typeof value.stopped !== 'boolean' || value.stopped !== (value.regressions === 3) ||
      (value.lastPromotedField === null) !== (value.sameFieldPromotions === 0)) {
    throw new Error('Invalid persisted RSI guardrail state; refusing to reset safety history');
  }
  return value as unknown as GuardrailState;
}
async function readState(path: string): Promise<GuardrailState> {
  try { return guardrails(await readJson(path)); }
  catch (error) {
    if (!object(error) || error.code !== 'ENOENT') throw error;
    return { version: 1, cycles: 0, regressions: 0, lastPromotedField: null, sameFieldPromotions: 0, stopped: false };
  }
}
const ResultSchema = z.object({
  caseId: z.string(), success: z.boolean(),
  elapsedMs: z.number().finite().nonnegative(),
  humanInterventions: z.number().int().nonnegative().safe(),
  failure: z.object({
    kind: z.enum(['selector', 'timeout', 'pace']), message: z.string(),
    selectorFallback: z.string().optional(), suggestedMs: z.number().finite().optional(),
  }).strict().optional(),
}).strict();
const HistorySchema = z.array(z.object({
  harness: z.unknown().transform(value => harness(value)), result: ResultSchema,
}).strict()).max(1000);

function checkedResults(value: readonly CaseResult[], cases: readonly EvaluationCase[]): CaseResult[] {
  const results = z.array(ResultSchema).parse(value);
  const ids = new Set(cases.map(item => item.id));
  if (results.length !== ids.size || results.some(item => !ids.delete(item.caseId))) {
    throw new Error('Evaluator must return every case exactly once');
  }
  return results;
}
/** Failures have no time-to-key: use all elapsed times only when no case succeeded. */
function metrics(results: readonly CaseResult[], weights: ScoreWeights): Metrics {
  const successes = results.filter(item => item.success);
  const durations = (successes.length ? successes : results).map(item => item.elapsedMs / 1000).sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const median = durations.length % 2 ? durations[middle]! : (durations[middle - 1]! + durations[middle]!) / 2;
  const successRate = successes.length / results.length;
  const humanInterventions = results.reduce((sum, item) => sum + item.humanInterventions, 0);
  const score = successRate * weights.successRate - median * weights.medianTimeToKeySeconds - humanInterventions * weights.humanInterventions;
  if (!Number.isFinite(score)) throw new Error('Non-finite RSI score');
  return { successRate, medianTimeToKeySeconds: median, humanInterventions, score };
}
function propose(current: HarnessConfig, results: readonly CaseResult[], attempted: Set<string>, state: GuardrailState): Mutation | null {
  for (const result of results) {
    if (result.success || !result.failure) continue;
    const failure = result.failure;
    const field: HarnessField = failure.kind === 'selector' ? 'selector' : failure.kind === 'timeout' ? 'timeoutMs' : 'paceMs';
    if (field === state.lastPromotedField && state.sameFieldPromotions >= 3) continue;
    const after = field === 'selector' ? failure.selectorFallback : failure.suggestedMs ??
      (field === 'timeoutMs' ? Math.min(current.timeoutMs * 2, 30_000) : Math.min(current.paceMs + 50, 5_000));
    if (after === undefined || after === current[field]) continue;
    try { harness({ ...current, [field]: after }); } catch { continue; }
    const key = JSON.stringify([field, after]);
    if (attempted.has(key)) continue;
    return { field, before: current[field], after, rationale: `Case ${result.caseId}: ${failure.message}` };
  }
  return null;
}
async function optionalText(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (object(error) && error.code === 'ENOENT') return ''; throw error; }
}
function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }

/**
 * Serialized, bounded local Propose–Probe–Compose. The evaluator is trusted executable code;
 * configuration candidates can change exactly one selector/timing field, never model or source.
 * Every probe executes fresh baseline and candidate runs on the same immutable case list.
 * Promotions require >2% gain relative to |baseline score| and preserve every successful case.
 * Rejections preserve harness bytes. Three cumulative regressions permanently stop this state.
 */
export async function runCycle(options: CycleOptions): Promise<CycleResult> {
  const maxMutations = options.maxMutations ?? 5;
  if (!Number.isInteger(maxMutations) || maxMutations < 1 || maxMutations > 5) throw new Error('maxMutations must be an integer from 1 to 5');
  const historyLimit = options.historyLimit ?? 20;
  if (!Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > 1000) throw new Error('historyLimit must be an integer from 1 to 1000');
  const weights = { ...(options.weights ?? DEFAULT_WEIGHTS) };
  if (Object.values(weights).length !== 3 || Object.values(weights).some(value => !Number.isFinite(value) || value < 0) || weights.successRate <= 0 ||
      !Number.isFinite(weights.medianTimeToKeySeconds) || !Number.isFinite(weights.humanInterventions)) throw new Error('Invalid RSI score weights');
  const cases = Object.freeze(options.cases.map(item => Object.freeze({ ...item })));
  if (!cases.length || cases.some(item => typeof item.id !== 'string' || !item.id) || new Set(cases.map(item => item.id)).size !== cases.length) {
    throw new Error('RSI requires unique nonempty case IDs');
  }
  const workspace = await realpath(resolve(options.workspace));
  const directory = join(workspace, 'rsi');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error('RSI directory must be inside the workspace, not a symlink');
  return withLock(join(directory, '.cycle.lock'), async () => {
    const harnessPath = join(directory, 'harness.json');
    if ((await lstat(harnessPath)).isSymbolicLink()) throw new Error('RSI harness must not be a symlink');
    let currentBytes = await readFile(harnessPath, 'utf8');
    let current = harness(JSON.parse(currentBytes) as unknown);
    const statePath = join(directory, 'state.json');
    const state = await readState(statePath);
    const historyPath = join(directory, 'failure-history.json');
    let history: z.infer<typeof HistorySchema>;
    try { history = HistorySchema.parse(await readJson(historyPath)).slice(-historyLimit); }
    catch (error) { if (!object(error) || error.code !== 'ENOENT') throw error; history = []; }
    const priorFailures = [...history];
    const runId = `${Date.now()}-${randomUUID()}`;
    const evidencePath = join(directory, 'runs', runId);
    await mkdir(evidencePath, { recursive: true, mode: 0o700 });
    await atomicWrite(join(evidencePath, 'prior-failures.json'), json(priorFailures));
    const result: CycleResult = {
      implementation: IMPLEMENTATION, runId, evidencePath, baseline: null, final: current,
      probes: [], state, stopReason: state.stopped ? 'regression-limit' : 'no-proposal',
    };
    state.cycles += 1;
    const persist = async () => {
      await atomicWrite(statePath, json(state));
      await atomicWrite(join(evidencePath, 'telemetry.json'), json({ ...result, weights, cases }));
    };
    await persist();
    if (state.stopped) return result;
    const attempted = new Set<string>();
    const evaluate = async (config: HarnessConfig, phase: 'baseline' | 'candidate', path: string) => {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const results = checkedResults(await options.evaluate({ harness: Object.freeze({ ...config }), cases, evidenceDir: path, phase }), cases);
      await atomicWrite(join(path, 'results.json'), json({ harness: config, results, metrics: metrics(results, weights) }));
      history.push(...results.filter(item => !item.success && item.failure).map(item => ({ harness: { ...config }, result: item })));
      history = history.slice(-historyLimit);
      await atomicWrite(historyPath, json(history));
      return results;
    };
    for (let index = 0; index < maxMutations; index += 1) {
      const probeDir = join(evidencePath, `probe-${index + 1}`);
      let baselineResults: CaseResult[];
      try { baselineResults = await evaluate(current, 'baseline', join(probeDir, 'baseline')); }
      catch (error) {
        await atomicWrite(join(evidencePath, 'error.json'), json({ phase: 'baseline', error: String(error) }));
        await persist();
        throw error;
      }
      const baseline = metrics(baselineResults, weights);
      result.baseline ??= baseline;
      const informedResults = baselineResults.map(item => {
        if (item.success || !item.failure) return item;
        const previous = priorFailures.findLast(entry => entry.result.caseId === item.caseId &&
          entry.harness.selector === current.selector && entry.harness.timeoutMs === current.timeoutMs &&
          entry.harness.paceMs === current.paceMs && entry.result.failure?.kind === item.failure!.kind)?.result.failure;
        if (!previous) return item;
        return { ...item, failure: {
          ...item.failure,
          selectorFallback: item.failure.selectorFallback ?? previous.selectorFallback,
          suggestedMs: item.failure.suggestedMs ?? previous.suggestedMs,
        } };
      });
      const mutation = propose(current, informedResults, attempted, state);
      if (!mutation) { result.stopReason = 'no-proposal'; break; }
      attempted.add(JSON.stringify([mutation.field, mutation.after]));
      const candidate = harness({ ...current, [mutation.field]: mutation.after });
      const probe: ProbeResult = { mutation, outcome: 'rejected', reason: '', baseline, candidate: null, relativeGain: null, evidencePath: probeDir };
      let candidateResults: CaseResult[] = [];
      try {
        candidateResults = await evaluate(candidate, 'candidate', join(probeDir, 'candidate'));
        probe.candidate = metrics(candidateResults, weights);
      } catch (error) {
        probe.reason = `Candidate evaluation failed: ${String(error)}`;
        await atomicWrite(join(probeDir, 'candidate-error.json'), json({ error: String(error) }));
      }
      const lostSuccess = baselineResults.some(item => item.success && !candidateResults.find(other => other.caseId === item.caseId)?.success);
      const delta = probe.candidate ? probe.candidate.score - baseline.score : null;
      probe.relativeGain = delta === null ? null : delta / Math.max(Math.abs(baseline.score), Number.EPSILON);
      const regression = !probe.candidate || lostSuccess || probe.candidate.successRate < baseline.successRate || probe.candidate.score < baseline.score;
      if (regression) {
        state.regressions += 1;
        state.stopped = state.regressions >= 3;
        probe.reason ||= lostSuccess ? 'Previously successful case regressed' : 'Candidate score regressed';
      } else if (probe.relativeGain !== null && probe.relativeGain > 0.02) {
        // Detect writes by the evaluator or an external editor rather than overwriting them.
        if (await readFile(harnessPath, 'utf8') !== currentBytes) throw new Error('Harness changed during evaluation; refusing promotion');
        probe.outcome = 'promoted';
        probe.reason = 'Relative score gain >2% with no successful-case regression';
        state.sameFieldPromotions = state.lastPromotedField === mutation.field ? state.sameFieldPromotions + 1 : 1;
        state.lastPromotedField = mutation.field;
        // Persist the conservative guardrail advance before committing configuration.
        await atomicWrite(statePath, json(state));
        currentBytes = json(candidate);
        await atomicWrite(harnessPath, currentBytes);
        current = candidate;
        result.final = current;
        const changelogPath = join(directory, 'CHANGELOG.md');
        const previous = await optionalText(changelogPath);
        const entry = `\n## ${runId} / probe ${index + 1}\n\n- Implementation: ${IMPLEMENTATION}; model unchanged.\n- Diff: ${mutation.field}: ${JSON.stringify(mutation.before)} → ${JSON.stringify(mutation.after)}\n- Score: ${baseline.score} → ${probe.candidate!.score}; delta ${delta}; relative gain ${probe.relativeGain}\n- Rationale: ${JSON.stringify(mutation.rationale)}\n- Evidence: ${probeDir}\n`;
        await atomicWrite(changelogPath, `${previous || '# Local harness promotions\n'}${entry}`);
      } else {
        probe.reason = 'Relative score gain must be strictly greater than 2%';
      }
      result.probes.push(probe);
      result.stopReason = state.stopped ? 'regression-limit' : index === maxMutations - 1 ? 'mutation-budget' : 'no-proposal';
      await atomicWrite(join(probeDir, 'decision.json'), json(probe));
      await persist();
      if (state.stopped) break;
    }
    await persist();
    return result;
  });
}
