// Unit tests for the workflow_job claim filter + provision projection (src/ingest/filter.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldClaim, toProvisionRequest, dedupeKey } from '../dist/src/ingest/filter.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CLAIMED = ['lambda-ci', 'lambda-ci-docker'];

function job(action, labels) {
  return { action, workflow_job: { labels } };
}

test('claims a queued job carrying our label', () => {
  assert.equal(shouldClaim(job('queued', ['lambda-ci']), CLAIMED), true);
});

test('claims case-insensitively', () => {
  assert.equal(shouldClaim(job('queued', ['LAMBDA-CI']), CLAIMED), true);
});

test('does not claim non-queued actions', () => {
  assert.equal(shouldClaim(job('in_progress', ['lambda-ci']), CLAIMED), false);
  assert.equal(shouldClaim(job('completed', ['lambda-ci']), CLAIMED), false);
});

test('does not claim jobs without our label', () => {
  assert.equal(shouldClaim(job('queued', ['ubuntu-latest']), CLAIMED), false);
  assert.equal(shouldClaim(job('queued', []), CLAIMED), false);
});

// The claim gate is an ALLOWLIST consulted BEFORE flavor resolution, and its value comes from
// `/lca/<env>/config/runner-labels` — seeded by hand from DEPLOY-M1, never published by the
// build script. So a flavor can be perfectly implemented, imaged, and resolvable and still be
// unreachable end-to-end: `shouldClaim` drops the webhook with 202 `claimed:false`, no runner
// is provisioned, and the job sits queued on GitHub with no error in any log. That is exactly
// what shipping the expanded standard set (ADR-039) without touching the seed would have done.
test('a flavor label absent from the claim list is silently never claimed', () => {
  // The failure mode, stated as a fact rather than a warning: this is why the seed matters.
  assert.equal(shouldClaim(job('queued', ['self-hosted', 'lambda-ci-python']), CLAIMED), false);
});

test('DEPLOY-M1 documents the full claim-label set for EVERY catalog flavor', () => {
  // DEPLOY-M1 phase 0 is the only place an operator learns what this parameter is for, so the
  // label set it prints must stay a superset of the catalog. Adding a flavor without extending
  // that reference fails here instead of in a queued-forever job.
  //
  // NOTE the shape this asserts, and why it changed (ADR-051). It used to parse the
  // `put-parameter --value '...'` seed COMMAND and require that to list every flavor. That was
  // wrong in the harmful direction: pre-seeding a label for a flavor whose image does not
  // exist yet makes ingest CLAIM those jobs and fail them in provisioning, after the
  // GitHub-hosted fallback is already gone. The seed command now bootstraps `lambda-ci` only
  // and `build:images` appends each label after its image verifies, so what must be complete
  // is the documented REFERENCE set, not the initial write.
  const catalog = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'microvm', 'flavors.json'), 'utf8'),
  );
  const deploy = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'DEPLOY-M1.md'), 'utf8');
  // Scope to FENCED CODE BLOCKS only. A bare document-wide search for `lambda-ci*` would be
  // satisfied by prose — including prose saying a label must NOT be seeded — so the reference
  // block this test exists to protect could be deleted while the guard stayed green. What an
  // operator can copy is what counts.
  const fenced = [...deploy.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
  assert.ok(fenced.length > 0, 'DEPLOY-M1 has no fenced blocks — has the runbook been rewritten?');
  const documented = [...fenced.matchAll(/(lambda-ci[A-Za-z0-9,-]*)/g)]
    .flatMap((m) => m[1].split(','))
    .map((l) => l.trim())
    .filter(Boolean);
  assert.ok(documented.length > 0, 'DEPLOY-M1 no longer documents any runner label');
  for (const flavor of catalog.flavors) {
    assert.ok(
      documented.includes(flavor.label),
      `DEPLOY-M1 never mentions '${flavor.label}' (flavor ${flavor.name}) — jobs with that ` +
        'label are dropped by shouldClaim before resolution ever runs, and an operator reading ' +
        'the runbook would have no way to know the label exists',
    );
    // ...and the documented label must be a value the gate actually accepts.
    assert.equal(
      shouldClaim(job('queued', ['self-hosted', flavor.label]), documented),
      true,
      `${flavor.label} should be claimed once documented`,
    );
  }
});

test('DEPLOY-M1 does not seed a label for a flavor phase 2 has not built', () => {
  // The ordering rule, asserted against the runbook (ADR-051). A seed command that pre-claims
  // every flavor label recreates the label-without-image state on a fresh environment: phase 0
  // runs before phase 2, so every one of those labels is claimed with no image behind it.
  const deploy = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'DEPLOY-M1.md'), 'utf8');
  const seeds = [...deploy.matchAll(/--value '([^']*lambda-ci[^']*)'/g)].map((m) => m[1]);
  for (const seed of seeds) {
    const labels = seed.split(',').map((l) => l.trim()).filter(Boolean);
    assert.deepEqual(
      labels,
      ['lambda-ci'],
      `DEPLOY-M1 seeds ${labels.length} labels (${seed}); phase 0 must seed only the base ` +
        'label — build:images adds each flavor label after that flavor\'s image verifies',
    );
  }
});

test('projects a webhook event into a provision request', () => {
  const event = {
    action: 'queued',
    workflow_job: {
      id: 42,
      run_id: 7,
      labels: ['lambda-ci'],
      name: 'build',
      status: 'queued',
      workflow_name: 'CI',
    },
    repository: { id: 99, name: 'repo', full_name: 'octo/repo', owner: { login: 'octo' } },
    installation: { id: 555 },
  };
  const req = toProvisionRequest(event);
  assert.deepEqual(req, {
    installationId: 555,
    repoId: 99,
    repoFullName: 'octo/repo',
    owner: 'octo',
    repo: 'repo',
    runId: 7,
    jobId: 42,
    labels: ['lambda-ci'],
    jobName: 'build',
    workflowName: 'CI',
  });
});

test('workflowName defaults to null when the webhook omits it', () => {
  const event = {
    action: 'queued',
    workflow_job: { id: 1, run_id: 2, labels: [], name: 'j', status: 'queued' },
    repository: { id: 3, name: 'r', full_name: 'o/r', owner: { login: 'o' } },
    installation: { id: 4 },
  };
  assert.equal(toProvisionRequest(event).workflowName, null);
});

test('dedupe key is stable and combines repo/run/job', () => {
  assert.equal(dedupeKey(99, 7, 42), '99:7:42');
});

// --- Repo opt-out gate (console `enabled` / `mode`, M4 review fix) -------------
// The management API only WRITES repo config; Ingest is the enforcement point. Without
// this, the console's Disable button and `mode: off` were cosmetic.
import { isRepoOptedOut } from '../dist/src/ingest/filter.js';

test('a repo disabled from the console is opted out', () => {
  assert.equal(isRepoOptedOut({ enabled: false, mode: 'label' }), true);
});

test('mode=off opts a repo out even while enabled', () => {
  assert.equal(isRepoOptedOut({ enabled: true, mode: 'off' }), true);
});

test('an enabled repo in label/adopt mode is claimed', () => {
  assert.equal(isRepoOptedOut({ enabled: true, mode: 'label' }), false);
  assert.equal(isRepoOptedOut({ enabled: true, mode: 'adopt' }), false);
  assert.equal(isRepoOptedOut({ enabled: true }), false, 'absent mode ⇒ label default');
});

test('a missing repo row fails OPEN (pre-M4 rows must still run)', () => {
  assert.equal(isRepoOptedOut(undefined), false);
});
