// deploy-env.test.mjs — deploy-target pin guard (ADR-018, extended by ADR-047).
//
// Covers: env-file parsing, pin validation (missing pin / bad account / bad region /
// region mismatch), the process-environment pin + its precedence against `.env.local`,
// and the full assertDeployTarget flow with an injected STS caller (match, mismatch,
// dry-run exemption, AWS_PROFILE export).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { parseEnvFile, validateTarget, assertDeployTarget, pinFromEnv, loadEnvLocal } = await import(
  '../dist/lib/deploy-env.js'
);

/** Run `fn` with the LCA_DEPLOY_* vars set to `vars`, restoring the previous values after. */
function withEnvPin(vars, fn) {
  const keys = ['LCA_DEPLOY_ACCOUNT', 'LCA_DEPLOY_REGION', 'LCA_DEPLOY_ENV'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) process.env[k] = v;
    return fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

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

test('validateTarget: missing pin → actionable error naming both sources', () => {
  assert.throws(() => validateTarget(null), /No deploy-target pin found/);
  assert.throws(() => validateTarget(null), /cp \.env\.local\.example/);
  assert.throws(() => validateTarget(null), /CI: export LCA_DEPLOY_ACCOUNT/);
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

test('assertDeployTarget: missing pin → refused before STS', () => {
  const repoRoot = tmpRepo(null);
  let stsCalled = false;
  withEnvPin({}, () => {
    assert.throws(
      () =>
        assertDeployTarget({
          repoRoot,
          getCaller: () => {
            stsCalled = true;
            return '863638663908';
          },
        }),
      /No deploy-target pin found/,
    );
  });
  assert.equal(stsCalled, false, 'must not call STS without a valid pin');
});

test('assertDeployTarget: dry-run skips everything', () => {
  const repoRoot = tmpRepo(null); // no .env.local at all
  const target = withEnvPin({}, () =>
    assertDeployTarget({
      repoRoot,
      dryRun: true,
      getCaller: () => {
        throw new Error('STS must not be called on dry-run');
      },
    }),
  );
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

test('assertDeployTarget: the confirmation goes to the injected sink, not stdout', () => {
  // `flavors:reconcile --json` promises stdout is exactly one parseable document (ADR-049).
  // This line printed unconditionally to stdout put a `✓ deploy target verified: …` prefix
  // ahead of that document, so `JSON.parse(stdout)` threw — the contract was false for every
  // JSON caller. The sink lets such a caller take it on stderr while interactive deploy
  // scripts keep it on stdout.
  const repoRoot = tmpRepo('LCA_DEPLOY_ACCOUNT=863638663908\nLCA_DEPLOY_REGION=us-west-2\n');
  const lines = [];
  const prevLog = console.log;
  let wroteStdout = false;
  console.log = () => {
    wroteStdout = true;
  };
  try {
    assertDeployTarget({ repoRoot, getCaller: () => '863638663908', log: (m) => lines.push(m) });
  } finally {
    console.log = prevLog;
  }
  assert.equal(lines.length, 1, 'the confirmation must reach the injected sink exactly once');
  assert.match(lines[0], /deploy target verified/);
  assert.equal(wroteStdout, false, 'nothing may go to stdout when a sink was supplied');
});

test('assertDeployTarget: default sink is stdout, for interactive deploy scripts', () => {
  const repoRoot = tmpRepo('LCA_DEPLOY_ACCOUNT=863638663908\nLCA_DEPLOY_REGION=us-west-2\n');
  const seen = [];
  const prevLog = console.log;
  console.log = (m) => seen.push(m);
  try {
    assertDeployTarget({ repoRoot, getCaller: () => '863638663908' });
  } finally {
    console.log = prevLog;
  }
  assert.equal(seen.length, 1);
  assert.match(seen[0], /deploy target verified: account 863638663908, region us-west-2/);
});

// --- process-environment pin (ADR-047) --------------------------------------
//
// A CI runner checks out a fresh clone: there is no gitignored `.env.local` to read, and
// committing one would publish the target account. The pin therefore has to be declarable in
// the job environment. What must NOT change is the STS identity comparison — a pin is a
// declaration of intent, never a grant — so every test below still proves the mismatch throw.

test('pinFromEnv: reads the LCA_DEPLOY_* trio, null when none are set', () => {
  assert.equal(pinFromEnv({}), null);
  assert.deepEqual(pinFromEnv({ LCA_DEPLOY_ACCOUNT: '863638663908', LCA_DEPLOY_REGION: 'us-west-2' }), {
    LCA_DEPLOY_ACCOUNT: '863638663908',
    LCA_DEPLOY_REGION: 'us-west-2',
  });
  assert.deepEqual(
    pinFromEnv({ LCA_DEPLOY_ACCOUNT: ' 863638663908 ', LCA_DEPLOY_REGION: 'us-west-2', LCA_DEPLOY_ENV: 'dev' }),
    { LCA_DEPLOY_ACCOUNT: '863638663908', LCA_DEPLOY_REGION: 'us-west-2', LCA_DEPLOY_ENV: 'dev' },
  );
  // AWS_PROFILE is deliberately NOT inherited: CI credentials come from the OIDC role.
  assert.equal(pinFromEnv({ AWS_PROFILE: 'some-profile' }), null);
  // Empty/whitespace values are not a pin (an unset repo variable expands to '').
  assert.equal(pinFromEnv({ LCA_DEPLOY_ACCOUNT: '', LCA_DEPLOY_REGION: '   ' }), null);
});

test('env-only pin is accepted when no .env.local exists', () => {
  const repoRoot = tmpRepo(null);
  const target = withEnvPin(
    { LCA_DEPLOY_ACCOUNT: '863638663908', LCA_DEPLOY_REGION: 'us-west-2', LCA_DEPLOY_ENV: 'dev' },
    () => assertDeployTarget({ repoRoot, env: 'dev', getCaller: () => '863638663908' }),
  );
  assert.deepEqual(target, { account: '863638663908', region: 'us-west-2', env: 'dev' });
});

test('.env.local wins over the environment pin', () => {
  // File pin says 863638663908; a stray exported variable says otherwise. The file is the
  // operator's standing declaration for this checkout, so an ambient variable must not be
  // able to redirect a workstation deploy.
  const repoRoot = tmpRepo('LCA_DEPLOY_ACCOUNT=863638663908\nLCA_DEPLOY_REGION=us-west-2\n');
  const resolved = withEnvPin(
    { LCA_DEPLOY_ACCOUNT: '111111111111', LCA_DEPLOY_REGION: 'eu-west-1' },
    () => loadEnvLocal(repoRoot),
  );
  assert.equal(resolved.LCA_DEPLOY_ACCOUNT, '863638663908');
  assert.equal(resolved.LCA_DEPLOY_REGION, 'us-west-2');

  const target = withEnvPin(
    { LCA_DEPLOY_ACCOUNT: '111111111111', LCA_DEPLOY_REGION: 'eu-west-1' },
    () => assertDeployTarget({ repoRoot, getCaller: () => '863638663908' }),
  );
  assert.deepEqual(target, { account: '863638663908', region: 'us-west-2' });
});

test('env pin + mismatched STS caller still refuses', () => {
  const repoRoot = tmpRepo(null);
  withEnvPin({ LCA_DEPLOY_ACCOUNT: '863638663908', LCA_DEPLOY_REGION: 'us-west-2' }, () => {
    assert.throws(
      () => assertDeployTarget({ repoRoot, getCaller: () => '111111111111' }),
      /Deploy-target mismatch/,
      'the identity check is the safety property and applies to env pins identically',
    );
  });
});

test('malformed env pin values are rejected exactly like file values', () => {
  const repoRoot = tmpRepo(null);
  const cases = [
    [{ LCA_DEPLOY_ACCOUNT: '123', LCA_DEPLOY_REGION: 'us-west-2' }, /LCA_DEPLOY_ACCOUNT must be a 12-digit/],
    [{ LCA_DEPLOY_ACCOUNT: '863638663908', LCA_DEPLOY_REGION: 'uswest2' }, /LCA_DEPLOY_REGION must be a region/],
    // A partial pin must fail loudly, not fall back to "unpinned" and deploy somewhere.
    [{ LCA_DEPLOY_ACCOUNT: '863638663908' }, /LCA_DEPLOY_REGION must be a region/],
    [{ LCA_DEPLOY_REGION: 'us-west-2' }, /LCA_DEPLOY_ACCOUNT must be a 12-digit/],
    [
      { LCA_DEPLOY_ACCOUNT: '863638663908', LCA_DEPLOY_REGION: 'us-west-2', LCA_DEPLOY_ENV: 'staging' },
      /LCA_DEPLOY_ENV must be 'dev' or 'prod'/,
    ],
  ];
  for (const [vars, re] of cases) {
    withEnvPin(vars, () => {
      assert.throws(
        () =>
          assertDeployTarget({
            repoRoot,
            getCaller: () => {
              throw new Error('STS must not be reached with a malformed pin');
            },
          }),
        re,
        `env pin ${JSON.stringify(vars)} should be rejected`,
      );
    });
  }
});

test('env pin binds the env selector the same way a file pin does', () => {
  const repoRoot = tmpRepo(null);
  withEnvPin(
    { LCA_DEPLOY_ACCOUNT: '863638663908', LCA_DEPLOY_REGION: 'us-west-2', LCA_DEPLOY_ENV: 'dev' },
    () => {
      assert.throws(
        () => assertDeployTarget({ repoRoot, env: 'prod', getCaller: () => '863638663908' }),
        /Deploy-env mismatch/,
      );
    },
  );
});

test('no pin anywhere → loadEnvLocal is null (credential-less synth stays exempt)', () => {
  const repoRoot = tmpRepo(null);
  assert.equal(withEnvPin({}, () => loadEnvLocal(repoRoot)), null);
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
