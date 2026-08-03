// Generative-UI security boundary + availability behaviour for the NL report path
// (src/mgmt/nl-report.ts, ADR-044 / ADR-045).
//
// The model is a *selector*, not an author. Everything it returns is parsed as data and run
// through the same validator the manual picker uses; a hostile, malformed, or merely creative
// response must be REFUSED, never repaired and never rendered. These tests are the acceptance
// criterion for that: each hostile payload below would be a real exploit if the pipeline
// evaluated, rendered, or trusted model output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MODEL_ID,
  MAX_INVOCATIONS_PER_CONTAINER,
  MAX_QUESTION_CHARS,
  MAX_SYSTEM_PROMPT_CHARS,
  RATE_LIMIT_PER_WINDOW,
  RATE_WINDOW_MS,
  buildSystemPrompt,
  checkQuestion,
  extractJson,
  proposeSpec,
  rateLimit,
  resetRateLimits,
  specFromCompletion,
} from '../dist/src/mgmt/nl-report.js';
import { CHART_TYPES, DIMENSIONS, METRICS, METRIC_CATALOG } from '../dist/src/mgmt/reports.js';
import fs from 'node:fs';

const NOW = new Date('2026-07-15T12:00:00.000Z');

// ---- happy path ------------------------------------------------------------

test('a well-formed model spec is accepted and normalized', () => {
  const res = specFromCompletion('{"metric":"spend","dimension":"repo","preset":"30d"}', NOW);
  assert.equal(res.ok, true);
  assert.equal(res.spec.metric, 'spend');
  assert.equal(res.spec.chart, 'bar'); // filled from DEFAULT_CHART, not from the model
  assert.ok(res.spec.from < res.spec.to);
});

test('a spec wrapped in prose or a code fence is still extracted', () => {
  const fenced = '```json\n{"metric":"runCount","dimension":"time"}\n```';
  assert.equal(specFromCompletion(fenced, NOW).ok, true);
  const chatty = 'Here you go:\n{"metric":"failureRate","dimension":"repo"}\nHope that helps!';
  assert.equal(specFromCompletion(chatty, NOW).ok, true);
});

test('an explicit unsupported marker is a clean refusal, not an error', () => {
  const res = specFromCompletion('{"unsupported": true}', NOW);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unsupported');
});

// ---- hostile / malformed model responses -----------------------------------

test('a model response that is not JSON is rejected', () => {
  for (const text of ['', 'I cannot help with that.', 'metric = spend', '[{"metric":"spend"}]']) {
    const res = specFromCompletion(text, NOW);
    assert.equal(res.ok, false, `accepted non-spec output: ${text}`);
    assert.equal(res.reason, 'invalid-spec');
  }
});

test('truncated JSON is rejected rather than half-parsed', () => {
  const res = specFromCompletion('{"metric":"spend","dimension":', NOW);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'invalid-spec');
});

test('a hallucinated metric is rejected with the validation errors, not repaired', () => {
  const res = specFromCompletion('{"metric":"revenue","dimension":"repo"}', NOW);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'invalid-spec');
  assert.ok(res.errors.join(' ').includes('metric must be one of'));
});

test('a model-authored DynamoDB query is rejected outright', () => {
  const res = specFromCompletion(
    JSON.stringify({
      metric: 'spend',
      query: { TableName: 'lca-dev', KeyConditionExpression: 'pk = :p' },
    }),
    NOW,
  );
  assert.equal(res.ok, false, 'a spec carrying a raw query was accepted');
});

test('a model-authored render payload is rejected', () => {
  // The whole point of constrained spec emission: no JS/JSX/HTML ever crosses the boundary.
  for (const payload of [
    { metric: 'spend', html: '<img src=x onerror=alert(1)>' },
    { metric: 'spend', component: 'function C(){return fetch("//evil")}' },
    { metric: 'spend', chart: '<script>alert(1)</script>' },
    { metric: 'spend', jsx: '<div/>' },
  ]) {
    const res = specFromCompletion(JSON.stringify(payload), NOW);
    assert.equal(res.ok, false, `accepted renderable payload: ${JSON.stringify(payload)}`);
  }
});

test('a model cannot widen authorization scope through the spec', () => {
  for (const payload of [
    { metric: 'spend', installationId: 22 },
    { metric: 'spend', filters: { installationIds: [22] } },
    { metric: 'spend', allRepos: true },
    { metric: 'spend', scope: 'platform' },
  ]) {
    const res = specFromCompletion(JSON.stringify(payload), NOW);
    assert.equal(res.ok, false, `accepted scope-widening field: ${JSON.stringify(payload)}`);
  }
});

test('a repoIds list from the model survives validation but is only ever a narrowing filter', () => {
  // Validation ALLOWS repoIds (the picker uses them); isolation is enforced server-side by
  // intersecting with the session's repos — see test/report-isolation.test.mjs. This test pins
  // the contract so nobody "fixes" one layer by weakening the other.
  const res = specFromCompletion('{"metric":"spend","filters":{"repoIds":[999999]}}', NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(res.spec.filters.repoIds, [999999]);
});

test('a model-supplied window beyond retention is rejected', () => {
  const res = specFromCompletion(
    '{"metric":"spend","from":"2010-01-01T00:00:00.000Z","to":"2026-07-15T00:00:00.000Z"}',
    NOW,
  );
  assert.equal(res.ok, false);
});

test('extractJson never evaluates and handles braces inside strings', () => {
  const parsed = extractJson('{"metric":"spend","note":"} not the end {"}');
  assert.deepEqual(parsed, { metric: 'spend', note: '} not the end {' });
  assert.equal(extractJson('no object here'), undefined);
});

test('an array of candidate specs is refused rather than silently taking the first', () => {
  // A model proposing several reports is ambiguous; picking one renders a report nobody chose.
  assert.equal(extractJson('[{"metric":"spend"},{"metric":"runCount"}]'), undefined);
  assert.equal(specFromCompletion('[{"metric":"spend"}]', NOW).ok, false);
});

// ---- prompt hygiene --------------------------------------------------------

test('the system prompt is built from the real vocabulary so it cannot drift', () => {
  const prompt = buildSystemPrompt();
  for (const m of METRICS) assert.ok(prompt.includes(m), `prompt omits metric ${m}`);
  for (const d of DIMENSIONS) assert.ok(prompt.includes(d), `prompt omits dimension ${d}`);
  for (const c of CHART_TYPES) assert.ok(prompt.includes(c), `prompt omits chart ${c}`);
});

test('the prompt forbids code output and repository identifiers', () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /do NOT write code/);
  assert.match(prompt, /Never include repository ids or names/);
});

test('the generated prompt stays inside its budget, and ADR-044 quotes the real figure', () => {
  // The prompt is the FIXED input cost of every question and it is generated from
  // `METRIC_CATALOG`, so a new metric or a widened definition raises the per-invocation bill on
  // a route whose model choice ADR-044 justifies partly by that bill being small. Nothing at
  // runtime can notice — there is no request-time input to reject — so the budget has to be a
  // test.
  const prompt = buildSystemPrompt();
  assert.ok(
    prompt.length <= MAX_SYSTEM_PROMPT_CHARS,
    `system prompt is ${prompt.length} chars, over the ${MAX_SYSTEM_PROMPT_CHARS} budget — shorten a ` +
      `metric definition (it is also operator-facing prose on the Reports panel) rather than raising the ceiling`,
  );

  // The catalog is the part that grows, so name it in the failure: this is where the chars are.
  const catalogChars = METRIC_CATALOG.reduce(
    (n, m) => n + m.metric.length + m.label.length + m.unit.length + m.definition.length,
    0,
  );
  assert.ok(
    catalogChars < prompt.length,
    'the catalog is meant to be the bulk of the prompt; this assertion has lost its subject',
  );

  // ADR-044 quotes the ceiling as part of its cost argument. A quoted number nobody checks is
  // how the previous "~400-token prompt" claim survived the prompt growing past 600 — the same
  // drift `test/mgmt-stack.test.mjs` prevents between the stack's model id and the handler's.
  const adr = fs.readFileSync(new URL('../docs/DECISIONS.md', import.meta.url), 'utf8');
  const quoted = adr.match(/system prompt\s*\ncapped at \*\*([\d\u202f\u00a0 ]+) characters/);
  assert.ok(quoted, 'ADR-044 no longer states the system-prompt budget');
  assert.equal(
    Number(quoted[1].replace(/[^\d]/g, '')),
    MAX_SYSTEM_PROMPT_CHARS,
    'ADR-044 quotes a prompt budget the code does not enforce',
  );
});

// ---- question validation ---------------------------------------------------

test('an empty, non-string, or oversized question is refused before any model spend', () => {
  assert.equal(checkQuestion('').ok, false);
  assert.equal(checkQuestion('   ').ok, false);
  assert.equal(checkQuestion(42).ok, false);
  assert.equal(checkQuestion({ q: 'spend' }).ok, false);
  assert.equal(checkQuestion('x'.repeat(MAX_QUESTION_CHARS + 1)).ok, false);
  assert.equal(checkQuestion('spend by repo').ok, true);
});

// ---- rate limiting + spend cap ---------------------------------------------

test('a session is rate limited within the window and told when to retry', () => {
  resetRateLimits();
  const t = 1_000_000;
  for (let i = 0; i < RATE_LIMIT_PER_WINDOW; i++) {
    assert.equal(rateLimit('operator', t).allowed, true, `call ${i} should be allowed`);
  }
  const blocked = rateLimit('operator', t);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'session-rate');
  assert.ok(blocked.retryAfterSeconds >= 1);
});

test('the window slides — an actor recovers after it passes', () => {
  resetRateLimits();
  const t = 2_000_000;
  for (let i = 0; i < RATE_LIMIT_PER_WINDOW; i++) rateLimit('operator', t);
  assert.equal(rateLimit('operator', t).allowed, false);
  assert.equal(rateLimit('operator', t + RATE_WINDOW_MS + 1).allowed, true);
});

test('limits are per actor, not global', () => {
  resetRateLimits();
  const t = 3_000_000;
  for (let i = 0; i < RATE_LIMIT_PER_WINDOW; i++) rateLimit('alice', t);
  assert.equal(rateLimit('alice', t).allowed, false);
  assert.equal(rateLimit('bob', t).allowed, true);
});

test('the container spend cap eventually refuses everyone', () => {
  resetRateLimits();
  let allowed = 0;
  // Walk the clock so the per-actor window never blocks; only the container budget can.
  for (let i = 0; i < MAX_INVOCATIONS_PER_CONTAINER + 10; i++) {
    if (rateLimit(`actor-${i}`, 4_000_000 + i * RATE_WINDOW_MS).allowed) allowed += 1;
  }
  assert.equal(allowed, MAX_INVOCATIONS_PER_CONTAINER);
  const blocked = rateLimit('anyone', 9_000_000_000);
  assert.equal(blocked.reason, 'container-budget');
  resetRateLimits();
});

// ---- availability ----------------------------------------------------------

test('a Bedrock fault degrades to an unavailable refusal, never a throw', async () => {
  const res = await proposeSpec('spend by repo', {
    now: NOW,
    invoke: async () => {
      throw new Error('ThrottlingException');
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unavailable');
});

test('proposeSpec runs the model output through the same validator', async () => {
  const good = await proposeSpec('spend by repo', {
    now: NOW,
    invoke: async () => '{"metric":"spend","dimension":"repo","preset":"7d"}',
  });
  assert.equal(good.ok, true);
  const bad = await proposeSpec('do something weird', {
    now: NOW,
    invoke: async () => '{"metric":"spend","eval":"process.exit(1)"}',
  });
  assert.equal(bad.ok, false);
});

test('the default model id is pinned, not latest-floating', () => {
  assert.match(DEFAULT_MODEL_ID, /^anthropic\.claude-3-5-sonnet-\d{8}-v\d:\d$/);
});

// ---- the model's menu tracks real retention ---------------------------------

function withRetention(days, fn) {
  const prev = process.env.RUN_RETENTION_DAYS;
  if (days === undefined) delete process.env.RUN_RETENTION_DAYS;
  else process.env.RUN_RETENTION_DAYS = String(days);
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.RUN_RETENTION_DAYS;
    else process.env.RUN_RETENTION_DAYS = prev;
  }
}

test('the prompt never offers a window this environment cannot serve', () => {
  // The prompt and the validator must show the same menu. Run retention is per-environment
  // (ADR-033: dev 30, prod 90), so a fixed `90d` in the prompt asks the model to propose specs
  // the validator then rejects — the operator gets a refusal for a reasonable question, on a
  // path whose entire availability story is "degrade gracefully".
  const dev = withRetention(30, () => buildSystemPrompt());
  assert.match(dev, /^preset: 24h \| 7d \| 30d$/m);
  assert.ok(!/90d/.test(dev), 'the prompt offers a preset the validator would reject');
  assert.match(dev, /Never propose a wider window than "30d"/);

  const prod = withRetention(90, () => buildSystemPrompt());
  assert.match(prod, /^preset: 24h \| 7d \| 30d \| 90d$/m);
  assert.match(prod, /Never propose a wider window than "90d"/);
});

test('a model-proposed window beyond THIS environment\'s retention is refused', () => {
  withRetention(30, () => {
    const r = specFromCompletion('{"metric":"spend","dimension":"repo","preset":"90d"}', NOW);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid-spec');
    assert.match((r.errors ?? []).join(' '), /30-day run retention/);
  });
});
