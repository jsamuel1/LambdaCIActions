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

test('extra OS capabilities are scoped to docker-capable flavors (ADR-020)', () => {
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
  // The catalog is the single source of truth for build-time capability grants (ADR-020):
  // FlavorDef must model every key flavors.json actually carries, or a typed consumer
  // silently loses it.
  const catalogKeys = new Set(catalog.flavors.flatMap((f) => Object.keys(f)));
  const flavorTs = fs.readFileSync(path.join(REPO_ROOT, 'src', 'provision', 'flavor.ts'), 'utf8');
  const iface = flavorTs.slice(
    flavorTs.indexOf('export interface FlavorDef'),
    flavorTs.indexOf('const FLAVORS'),
  );
  for (const key of catalogKeys) {
    // `dockerfile` is build-script-only and deliberately absent from the routing type.
    if (key === 'dockerfile' || key === 'runHookPort') continue;
    assert.match(iface, new RegExp(`\\b${key}\\??:`), `FlavorDef is missing catalog key '${key}'`);
  }
  // The build script must actually forward them.
  const build = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build-images.mjs'), 'utf8');
  assert.match(build, /--additional-os-capabilities/);
  assert.match(build, /flavor\.osCapabilities/);
});

test('the build script requests the catalog memory + arm64 CPU config (ADR-030)', () => {
  // `memoryMb` was inert until this was sent: run-microvm has NO sizing parameter, and
  // create-microvm-image takes memory only via --resources minimumMemoryInMiB. Without these
  // flags every flavor — including the 8 GB ones — builds at the service default.
  const build = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build-images.mjs'), 'utf8');
  assert.match(build, /--resources/);
  assert.match(build, /minimumMemoryInMiB=\$\{flavor\.memoryMb\}/);
  assert.match(build, /--cpu-configurations/);
  assert.match(build, /architecture=ARM_64/);
  // There is no vCPU knob on the API — don't invent one.
  assert.doesNotMatch(build, /minimumVcpu|vcpuCount|--vcpu/);
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

test('the pre-run hook failure path still starts the agent so GitHub reports the failure', () => {
  const hook = read('bootstrap/run-hook.mjs');
  // A nonzero pre-hook must be LOGGED, not fatal: the agent still starts and the job fails
  // at its first `docker` step. Bailing here would leave the GitHub job hanging until its
  // own timeout with no runner attached.
  assert.match(hook, /pre-run hook nonzero exit/);
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

// ADR-028 sizes the boot broker budget against the COLD start of the CLI the GUEST runs, and
// its pre-warm decides `warmed` by matching that CLI's botocore connect-error wording. Both are
// empirical facts about a specific binary: apt's `awscli` on Ubuntu 22.04, i.e. aws-cli v1
// (1.22.34 / botocore 1.23.34) — NOT the deploy host's v2. The >=2.35.17 floor in spec 05 is a
// deployer requirement (it needs the `lambda-microvms` service model); the guest only calls
// plain `lambda invoke`, which v1 has.
//
// So pin the provenance: swapping the guest to CLI v2, or to a base image whose apt `awscli` is
// a different major, silently invalidates the measured 6 s-vs-15 s budget AND the `warmed`
// regex. Neither failure is visible at build time — a mismatched regex just reports
// `warmed:false` forever, and an unmeasured cold cost is exactly how the original zero-margin
// budget shipped. Fail here instead, so the change comes with a re-measurement.
test('flavors install the apt awscli that ADR-028 measured, not a swapped-in CLI v2', () => {
  const catalog = JSON.parse(read('flavors.json'));
  for (const flavor of catalog.flavors) {
    const df = read(flavor.dockerfile);
    assert.match(
      df,
      /^\s+libicu70 lsb-release awscli \\$/m,
      `${flavor.dockerfile} must install the apt awscli package (ADR-028 measured aws-cli v1)`,
    );
    // A v2 install is the specific swap that would invalidate the budget + the warmed regex.
    assert.doesNotMatch(
      df,
      /awscli-exe-linux|awscliv2|aws\/install/,
      `${flavor.dockerfile} installs AWS CLI v2 — re-measure the ADR-028 cold cost and the ` +
        'prewarm warmed regex before allowing this',
    );
    // ...and the reason must travel with the line, or the next reader deletes it as noise.
    assert.match(
      df,
      /aws-cli \*\*v1\*\*/,
      `${flavor.dockerfile} must state why apt awscli (v1) is deliberate — see ADR-028`,
    );
  }
});

// --- Expanded standard set (ADR-031) -----------------------------------------

/** Flavors whose toolchain is meant to be resolvable from the runner tool cache. */
const TOOLCACHE_FLAVORS = ['node', 'python', 'java', 'go'];

test('every catalog flavor has a Dockerfile that exists', () => {
  const catalog = JSON.parse(read('flavors.json'));
  for (const flavor of catalog.flavors) {
    assert.doesNotThrow(() => read(flavor.dockerfile), `missing ${flavor.dockerfile}`);
  }
});

test('flavor names, labels and dockerfiles are unique', () => {
  const catalog = JSON.parse(read('flavors.json'));
  for (const key of ['name', 'label', 'dockerfile']) {
    const values = catalog.flavors.map((f) => f[key]);
    assert.equal(new Set(values).size, values.length, `duplicate flavor ${key}`);
  }
});

test('every flavor label starts with the base lambda-ci label', () => {
  // Resolution matches the LONGEST catalog label present in runs-on; a label outside this
  // namespace would not be recognizable as ours.
  const catalog = JSON.parse(read('flavors.json'));
  for (const flavor of catalog.flavors) {
    assert.match(flavor.label, /^lambda-ci(-[a-z0-9]+)?$/, `odd label '${flavor.label}'`);
  }
});

test('tool-cache flavors set RUNNER_TOOL_CACHE explicitly', () => {
  // A self-hosted runner does NOT default to /opt/hostedtoolcache — actions/runner resolves
  // RUNNER_TOOL_CACHE ?? RUNNER_TOOLSDIRECTORY ?? AGENT_TOOLSDIRECTORY and otherwise falls
  // back to _work/_tool. Without this the prebaked cache is in a directory the agent never
  // looks at, and every setup-* step silently re-downloads.
  for (const name of TOOLCACHE_FLAVORS) {
    const df = read(`Dockerfile.${name}`);
    assert.match(df, /RUNNER_TOOL_CACHE=\/opt\/hostedtoolcache/, `${name}: must pin RUNNER_TOOL_CACHE`);
  }
});

test('every prebaked tool-cache entry writes the sibling .complete marker', () => {
  // @actions/tool-cache find() requires BOTH <tool>/<version>/<arch>/ and the sibling file
  // <tool>/<version>/<arch>.complete. Omitting the marker is the classic silent failure:
  // the toolchain is on disk but the action re-downloads it anyway.
  for (const name of TOOLCACHE_FLAVORS) {
    const df = read(`Dockerfile.${name}`);
    const hasMarker =
      /arm64\.complete/.test(df) ||
      // the python flavor delegates to the upstream setup.sh, which writes the marker itself
      /setup\.sh/.test(df);
    assert.ok(hasMarker, `${name}: no sibling arm64.complete marker is created`);
  }
});

test('tool-cache entries use the exact toolName the setup action looks up', () => {
  // These strings are case-sensitive filesystem paths. `Python` is capitalized;
  // `node`/`go` are not; setup-java uses Java_<distribution>_<packageType>.
  assert.match(read('Dockerfile.python'), /\/Python\//, 'setup-python looks up "Python"');
  assert.match(read('Dockerfile.node'), /\/node\/\$\{NODE_VERSION\}/, 'setup-node looks up "node"');
  assert.match(read('Dockerfile.go'), /\/go\/\$\{GO_VERSION\}/, 'setup-go looks up "go"');
  assert.match(read('Dockerfile.java'), /Java_temurin_jdk/, 'setup-java looks up Java_<distro>_<pkg>');
});

test('the java tool-cache version dir uses - not + for the build separator', () => {
  // setup-java stores 21.0.12+8 as `21.0.12-8` (a '+' in JAVA_HOME breaks toolchains) and maps
  // it back when scanning. A '+' on disk means findAllVersions never sees the entry.
  const df = read('Dockerfile.java');
  assert.match(df, /Java_temurin_jdk\/\$\{JDK_VERSION\}-\$\{JDK_BUILD\}\/arm64/);
  assert.doesNotMatch(df, /Java_temurin_jdk\/\$\{JDK_VERSION\}\+/);
});

test('toolchain versions are pinned, not latest (reproducible rebuilds)', () => {
  // ADR-031: a `latest`/`stable` toolchain makes two builds of the same commit differ.
  const pins = {
    python: /ARG PYTHON_VERSION=\d+\.\d+\.\d+/,
    java: /ARG JDK_VERSION=\d+\.\d+\.\d+/,
    go: /ARG GO_VERSION=\d+\.\d+\.\d+/,
    rust: /ARG RUST_VERSION=\d+\.\d+\.\d+/,
    node: /ARG NODE_VERSION=\d+\.\d+\.\d+/,
  };
  for (const [name, re] of Object.entries(pins)) {
    assert.match(read(`Dockerfile.${name}`), re, `${name}: toolchain version must be pinned`);
  }
  // The rust toolchain must not be installed as a floating channel.
  assert.doesNotMatch(read('Dockerfile.rust'), /--default-toolchain stable/);
});

test('every flavor Dockerfile bakes the run-hook server and exposes its port', () => {
  // The whole boot contract (ADR-012/016): no run-hook, no job.
  const catalog = JSON.parse(read('flavors.json'));
  for (const flavor of catalog.flavors) {
    const df = read(flavor.dockerfile);
    assert.match(df, /COPY bootstrap\/run-hook\.mjs \$\{RUNNER_DIR\}\/run-hook\.mjs/, flavor.name);
    assert.match(df, /ENTRYPOINT \["node", "\/opt\/actions-runner\/run-hook\.mjs"\]/, flavor.name);
    assert.match(df, /EXPOSE 8080/, flavor.name);
  }
});

test('every flavor pins the same runner agent version', () => {
  // A flavor that drifts to a different agent version is a support problem that only shows
  // up on that one flavor's jobs.
  const catalog = JSON.parse(read('flavors.json'));
  const versions = new Set(
    catalog.flavors.map((f) => read(f.dockerfile).match(/ARG RUNNER_VERSION=([\d.]+)/)?.[1]),
  );
  assert.equal(versions.size, 1, `runner agent versions diverge across flavors: ${[...versions]}`);
  assert.ok(!versions.has(undefined), 'a flavor Dockerfile has no pinned RUNNER_VERSION');
});

test('the catalog memory values are plausible microVM requests', () => {
  const catalog = JSON.parse(read('flavors.json'));
  for (const flavor of catalog.flavors) {
    assert.ok(Number.isInteger(flavor.memoryMb), `${flavor.name}: memoryMb must be an integer MiB`);
    assert.ok(flavor.memoryMb >= 1024, `${flavor.name}: memoryMb too small`);
    assert.ok(flavor.memoryMb <= 32768, `${flavor.name}: memoryMb beyond a sane per-VM bound`);
    assert.ok(Number.isInteger(flavor.vcpu) && flavor.vcpu > 0, `${flavor.name}: vcpu`);
  }
});
