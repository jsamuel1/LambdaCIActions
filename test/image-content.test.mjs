// Unit tests for the microVM image content contract (flavor Dockerfiles + bootstrap hooks).
//
// The docker flavor's daemon can only start because run-hook.mjs executes
// ${RUNNER_DIR}/pre-run.sh before the runner agent, and Dockerfile.docker bakes
// bootstrap/pre-run.docker.sh in at that path. M3 verification found this missing (jobs
// failed with "dial unix /var/run/docker.sock: no such file or directory"), so pin the wiring.
//
// Run: node --test test/   (or: npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MICROVM = path.join(REPO_ROOT, 'microvm');
const read = (p) => fs.readFileSync(path.join(MICROVM, p), 'utf8');

test('run-hook runs ${RUNNER_DIR}/pre-run.sh before the runner agent', () => {
  const hook = read('bootstrap/run-hook.mjs');
  assert.match(hook, /\$\{RUNNER_DIR\}\/pre-run\.sh/);
  // The hook must be invoked before run.sh --jitconfig is spawned.
  assert.ok(
    hook.indexOf('pre-run.sh') < hook.indexOf("'--jitconfig'"),
    'pre-run hook must be executed before the runner agent is spawned',
  );
});

test('docker flavor bakes the dockerd pre-run hook in at pre-run.sh', () => {
  const df = read('Dockerfile.docker');
  assert.match(df, /COPY bootstrap\/pre-run\.docker\.sh \$\{RUNNER_DIR\}\/pre-run\.sh/);
  assert.match(df, /chmod 0755 \$\{RUNNER_DIR\}\/pre-run\.sh/);
});

test('the dockerd pre-run hook starts dockerd and waits for the API', () => {
  const sh = read('bootstrap/pre-run.docker.sh');
  assert.match(sh, /nohup dockerd/, 'must start dockerd in the background');
  assert.match(sh, /docker version --format/, 'must poll the daemon API for readiness');
  // The snapshot has no init: dockerd needs the unified cgroup hierarchy mounted or it dies
  // with "Devices cgroup isn't mounted".
  assert.match(sh, /mount -t cgroup2/, 'must mount cgroup2 (no init in the snapshot)');
  // sudo can NEVER escalate in-guest (kernel no_new_privs) — the hook must already be root.
  const commands = sh
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  assert.ok(
    !commands.some((l) => /^sudo\s/.test(l)),
    'must not invoke sudo (it cannot escalate under no_new_privs)',
  );
  assert.match(sh, /id -u/, 'must assert it is running as root');
  // A hung daemon must fail the job fast rather than stall the whole microVM lifetime.
  assert.match(sh, /deadline|SECONDS/, 'must bound the readiness wait');
});

test('run-hook drops root to the runner user with setpriv (agent refuses root)', () => {
  const hook = read('bootstrap/run-hook.mjs');
  assert.match(hook, /setpriv/, 'must use setpriv for the downward privilege change');
  assert.match(hook, /--init-groups/, 'must keep supplementary groups (docker)');
  assert.match(hook, /process\.getuid\(\) === 0/, 'must only drop privileges when running as root');
});

test('docker flavor keeps a root entrypoint; base/node stay unprivileged', () => {
  const catalog = JSON.parse(read('flavors.json'));
  for (const flavor of catalog.flavors) {
    const df = read(flavor.dockerfile);
    const rootEntrypoint = !/^USER runner$/m.test(df);
    assert.equal(
      rootEntrypoint,
      flavor.capabilities.includes('docker'),
      `flavor ${flavor.name}: only docker-capable flavors may keep a root entrypoint`,
    );
  }
});

test('extra OS capabilities are scoped to docker-capable flavors (ADR-019)', () => {
  const catalog = JSON.parse(read('flavors.json'));
  for (const flavor of catalog.flavors) {
    const wants = flavor.osCapabilities ?? [];
    assert.equal(
      wants.length > 0,
      flavor.capabilities.includes('docker'),
      `flavor ${flavor.name}: only docker-capable flavors may request extra OS capabilities`,
    );
    // ALL is the only value the GA lambda-microvms API accepts today.
    for (const cap of wants) assert.equal(cap, 'ALL', `unsupported osCapability '${cap}'`);
  }
  // The build script must actually forward them.
  const build = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build-images.mjs'), 'utf8');
  assert.match(build, /--additional-os-capabilities/);
  assert.match(build, /flavor\.osCapabilities/);
});

test('only docker-capable flavors ship a pre-run hook', () => {
  const catalog = JSON.parse(read('flavors.json'));
  for (const flavor of catalog.flavors) {
    const df = read(flavor.dockerfile);
    const shipsHook = /pre-run\.\w+\.sh \$\{RUNNER_DIR\}\/pre-run\.sh/.test(df);
    assert.equal(
      shipsHook,
      flavor.capabilities.includes('docker'),
      `flavor ${flavor.name}: pre-run hook presence must match its docker capability`,
    );
  }
});

test('every flavor Dockerfile is arm64-only (AGENTS.md hard rule)', () => {
  const catalog = JSON.parse(read('flavors.json'));
  for (const flavor of catalog.flavors) {
    assert.equal(flavor.arch, 'arm64', `flavor ${flavor.name} must be arm64`);
    const df = read(flavor.dockerfile);
    assert.match(df, /FROM --platform=linux\/arm64 /, `${flavor.dockerfile} must pin linux/arm64`);
    assert.doesNotMatch(df, /arch=amd64|linux\/amd64|x86_64\.tar\.gz/, `${flavor.dockerfile} has an x86 artifact`);
  }
});
