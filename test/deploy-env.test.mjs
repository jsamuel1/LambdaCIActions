// deploy-env.test.mjs — deploy-target pin guard (ADR-018).
//
// Covers: env-file parsing, pin validation (missing file / bad account / bad region /
// region mismatch), and the full assertDeployTarget flow with an injected STS caller
// (match, mismatch, dry-run exemption, AWS_PROFILE export).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { parseEnvFile, validateTarget, assertDeployTarget } = await import(
  '../dist/lib/deploy-env.js'
);

// --- parseEnvFile -----------------------------------------------------------

test('parseEnvFile: KEY=VALUE, comments, blanks, quotes', () => {
  const parsed = parseEnvFile(
    [
      '# comment',
      '',
      'LCA_DEPLOY_ACCOUNT=863638663908',
      "LCA_DEPLOY_REGION='us-west-2'",
      'AWS_PROFILE="my profile"',
      'NOEQUALS',
      '=nokey',
    ].join('\n'),
  );
  assert.deepEqual(parsed, {
    LCA_DEPLOY_ACCOUNT: '863638663908',
    LCA_DEPLOY_REGION: 'us-west-2',
    AWS_PROFILE: 'my profile',
  });
});

// --- validateTarget ---------------------------------------------------------

const GOOD = { LCA_DEPLOY_ACCOUNT: '863638663908', LCA_DEPLOY_REGION: 'us-west-2' };

test('validateTarget: happy path', () => {
  assert.deepEqual(validateTarget(GOOD), { account: '863638663908', region: 'us-west-2' });
});

test('validateTarget: missing .env.local → actionable error', () => {
  assert.throws(() => validateTarget(null), /\.env\.local is missing/);
  assert.throws(() => validateTarget(null), /cp \.env\.local\.example/);
});

test('validateTarget: bad account rejected', () => {
  for (const bad of [undefined, '', '123', '12345678901x', 'accountid']) {
    assert.throws(
      () => validateTarget({ ...GOOD, LCA_DEPLOY_ACCOUNT: bad }),
      /LCA_DEPLOY_ACCOUNT must be a 12-digit/,
      `account "${bad}" should be rejected`,
    );
  }
});

test('validateTarget: bad region rejected', () => {
  for (const bad of [undefined, '', 'uswest2', 'us-west', 'US-WEST-2']) {
    assert.throws(
      () => validateTarget({ ...GOOD, LCA_DEPLOY_REGION: bad }),
      /LCA_DEPLOY_REGION must be a region/,
      `region "${bad}" should be rejected`,
    );
  }
});

test('validateTarget: explicit region must match pin', () => {
  assert.throws(() => validateTarget(GOOD, { region: 'us-east-1' }), /Region mismatch/);
  assert.deepEqual(validateTarget(GOOD, { region: 'us-west-2' }).region, 'us-west-2');
});

// --- assertDeployTarget (fs + injected STS) ---------------------------------

function tmpRepo(envLocalText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-deploy-env-'));
  if (envLocalText !== null) fs.writeFileSync(path.join(dir, '.env.local'), envLocalText);
  return dir;
}

test('assertDeployTarget: caller matches pin → target returned', () => {
  const repoRoot = tmpRepo('LCA_DEPLOY_ACCOUNT=863638663908\nLCA_DEPLOY_REGION=us-west-2\n');
  const target = assertDeployTarget({ repoRoot, getCaller: () => '863638663908' });
  assert.deepEqual(target, { account: '863638663908', region: 'us-west-2' });
});

test('assertDeployTarget: caller mismatch → refused', () => {
  const repoRoot = tmpRepo('LCA_DEPLOY_ACCOUNT=863638663908\nLCA_DEPLOY_REGION=us-west-2\n');
  assert.throws(
    () => assertDeployTarget({ repoRoot, getCaller: () => '111111111111' }),
    /Deploy-target mismatch/,
  );
});

test('assertDeployTarget: missing .env.local → refused before STS', () => {
  const repoRoot = tmpRepo(null);
  let stsCalled = false;
  assert.throws(
    () =>
      assertDeployTarget({
        repoRoot,
        getCaller: () => {
          stsCalled = true;
          return '863638663908';
        },
      }),
    /\.env\.local is missing/,
  );
  assert.equal(stsCalled, false, 'must not call STS without a valid pin');
});

test('assertDeployTarget: dry-run skips everything', () => {
  const repoRoot = tmpRepo(null); // no .env.local at all
  const target = assertDeployTarget({
    repoRoot,
    dryRun: true,
    getCaller: () => {
      throw new Error('STS must not be called on dry-run');
    },
  });
  assert.equal(target, null);
});

test('assertDeployTarget: AWS_PROFILE exported from pin when unset', () => {
  const prev = process.env.AWS_PROFILE;
  delete process.env.AWS_PROFILE;
  try {
    const repoRoot = tmpRepo(
      'LCA_DEPLOY_ACCOUNT=863638663908\nLCA_DEPLOY_REGION=us-west-2\nAWS_PROFILE=pinned-profile\n',
    );
    assertDeployTarget({ repoRoot, getCaller: () => '863638663908' });
    assert.equal(process.env.AWS_PROFILE, 'pinned-profile');
  } finally {
    if (prev === undefined) delete process.env.AWS_PROFILE;
    else process.env.AWS_PROFILE = prev;
  }
});

test('assertDeployTarget: shell AWS_PROFILE wins over pin', () => {
  const prev = process.env.AWS_PROFILE;
  process.env.AWS_PROFILE = 'shell-profile';
  try {
    const repoRoot = tmpRepo(
      'LCA_DEPLOY_ACCOUNT=863638663908\nLCA_DEPLOY_REGION=us-west-2\nAWS_PROFILE=pinned-profile\n',
    );
    assertDeployTarget({ repoRoot, getCaller: () => '863638663908' });
    assert.equal(process.env.AWS_PROFILE, 'shell-profile');
  } finally {
    if (prev === undefined) delete process.env.AWS_PROFILE;
    else process.env.AWS_PROFILE = prev;
  }
});

// --- env binding (ADR-033: dev and prod are separate ACCOUNTS) ---------------
//
// `-c env=prod` / `--env prod` selects resource NAMES, retention, concurrency and alarm
// thresholds; the account came from an independent pin. With nothing tying the two together, a
// pin for the dev account plus `env=prod` deployed `lca-prod-*` resources — and published
// prod-namespaced image ARNs, and wrote App secrets to `/lca/prod/github/*` — into the DEV
// account. The reciprocal was equally possible. The pin is the only authority on which
// environment a checkout may build.
const PINNED_DEV = { ...GOOD, LCA_DEPLOY_ENV: 'dev' };

test('validateTarget: pinned env is returned and matching selection passes', () => {
  assert.deepEqual(validateTarget(PINNED_DEV, { env: 'dev' }), {
    account: GOOD.LCA_DEPLOY_ACCOUNT,
    region: GOOD.LCA_DEPLOY_REGION,
    env: 'dev',
  });
});

test('validateTarget: selecting prod against a dev pin is refused (and vice versa)', () => {
  assert.throws(() => validateTarget(PINNED_DEV, { env: 'prod' }), /Deploy-env mismatch/);
  assert.throws(
    () => validateTarget({ ...GOOD, LCA_DEPLOY_ENV: 'prod' }, { env: 'dev' }),
    /Deploy-env mismatch/,
  );
});

test('validateTarget: a bogus pinned env is rejected outright', () => {
  assert.throws(() => validateTarget({ ...GOOD, LCA_DEPLOY_ENV: 'staging' }), /must be 'dev' or 'prod'/);
});

test('validateTarget: an unpinned env stays permissive (legacy single-account setup)', () => {
  // Omitting LCA_DEPLOY_ENV must not break existing checkouts — the account+region pin still
  // applies, and no env claim exists to contradict.
  const t = validateTarget(GOOD, { env: 'prod' });
  assert.equal(t.env, undefined);
  assert.equal(t.account, GOOD.LCA_DEPLOY_ACCOUNT);
});

test('assertDeployTarget: env mismatch is refused before STS is called', () => {
  const repoRoot = tmpRepo(
    `LCA_DEPLOY_ACCOUNT=${GOOD.LCA_DEPLOY_ACCOUNT}\nLCA_DEPLOY_REGION=${GOOD.LCA_DEPLOY_REGION}\nLCA_DEPLOY_ENV=dev\n`,
  );
  let stsCalls = 0;
  assert.throws(
    () =>
      assertDeployTarget({
        repoRoot,
        env: 'prod',
        getCaller: () => {
          stsCalls += 1;
          return GOOD.LCA_DEPLOY_ACCOUNT;
        },
      }),
    /Deploy-env mismatch/,
  );
  assert.equal(stsCalls, 0, 'the pin must be validated before any AWS call');
});

test('every deploy-touching entrypoint binds its env selector to the pin', () => {
  const root = path.join(import.meta.dirname, '..');
  // cdk app
  assert.match(
    fs.readFileSync(path.join(root, 'bin', 'lca.ts'), 'utf8'),
    /validateTarget\(envLocal, \{ region: requestedRegion, env: envName \}\)/,
  );
  // image build (publishes image ARNs under /lca/<env>/) and app:create (writes App secrets
  // under /lca/<env>/github/) are the same boundary.
  for (const script of ['build-images.mjs', 'create-github-app.mjs']) {
    assert.match(
      fs.readFileSync(path.join(root, 'scripts', script), 'utf8'),
      /assertDeployTarget\(\{ repoRoot: REPO_ROOT, region: REGION, env: ENV \}\)/,
      `${script} must bind its --env to the pin`,
    );
  }
});
