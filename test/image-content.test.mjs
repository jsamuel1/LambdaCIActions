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

test('the build script requests the catalog memory + arm64 CPU config (ADR-038)', () => {
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

// --- Expanded standard set (ADR-039) -----------------------------------------

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
  // ADR-039: a `latest`/`stable` toolchain makes two builds of the same commit differ.
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

test('no flavor installs a floating @latest / @stable package version', () => {
  // The reproducibility claim in ADR-039 covers the whole image, not just the language
  // runtime: `corepack prepare pnpm@latest` and `npm install -g npm@latest` resolve at BUILD
  // time, so two builds of the SAME commit ship different package managers and a job that
  // breaks on a new pnpm/npm major cannot be reproduced from the Dockerfile. A pinned runtime
  // beside a floating package manager is a half-kept promise.
  const catalog = JSON.parse(read('flavors.json'));
  for (const flavor of catalog.flavors) {
    const instructions = read(flavor.dockerfile)
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    const floating = [...instructions.matchAll(/[A-Za-z0-9@/._-]+@(?:latest|stable|next)\b/g)].map(
      (m) => m[0],
    );
    assert.deepEqual(
      floating,
      [],
      `${flavor.dockerfile} installs a floating version (${floating.join(', ')}) — pin it via an ` +
        'ARG so a rebuild of this commit is reproducible (ADR-039)',
    );
  }
});

test('the node flavor pins its package managers via ARGs it actually uses', () => {
  // A pin that is declared but not referenced is decoration — the RUN line must consume it.
  const df = read('Dockerfile.node');
  for (const [arg, tool] of [
    ['PNPM_VERSION', 'pnpm'],
    ['YARN_VERSION', 'yarn'],
    ['NPM_VERSION', 'npm'],
  ]) {
    assert.match(df, new RegExp(`ARG ${arg}=\\d+\\.\\d+\\.\\d+`), `node: must pin ${tool}`);
    assert.match(
      df,
      new RegExp(`${tool}@\\$\\{${arg}\\}`),
      `node: ${tool} install must consume \${${arg}}, not a literal or a floating tag`,
    );
  }
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

test('no flavor chowns a directory nothing created (image build would fail)', () => {
  // `chown -R` on a missing path is a hard, non-obvious image-build failure: the rust flavor
  // bakes no tool-cache entry, so nothing else in that Dockerfile creates
  // ${RUNNER_TOOL_CACHE} and the final chown aborted the build. Every chowned path must be
  // created earlier in the same Dockerfile.
  const catalog = JSON.parse(read('flavors.json'));
  for (const flavor of catalog.flavors) {
    const df = read(flavor.dockerfile);
    const chowned = new Set(
      [...df.matchAll(/chown -R runner:runner ([^\n\\]+)/g)].flatMap((m) => m[1].trim().split(/\s+/)),
    );
    const made = [...df.matchAll(/mkdir -p ([^\n\\]+)/g)].flatMap((m) =>
      m[1].trim().split(/\s+/),
    );
    for (const target of chowned) {
      // A mkdir of a SUBPATH also creates the parent, so a prefix match counts.
      assert.ok(
        made.some((m) => m === target || m.startsWith(`${target}/`)),
        `${flavor.dockerfile}: chowns '${target}' but never mkdir -p's it (or a subpath) — the ` +
          `build fails with "chown: cannot access ...: No such file or directory"`,
      );
    }
  }
});

test('rustup-init passes one --component per occurrence', () => {
  // rustup-init's clap parser takes a SINGLE value per --component: `--component clippy rustfmt`
  // exits with "unexpected argument 'rustfmt' found" and fails the image build. Verified against
  // a real rustup-init run.
  const df = read('Dockerfile.rust');
  // Comment lines document the wrong form on purpose — only inspect real instructions.
  const instructions = df
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  const components = [...instructions.matchAll(/--component[ \t]+([^\s\\]+)([ \t]+[^\s\\-][^\s\\]*)?/g)];
  assert.ok(components.length >= 2, 'rust must install clippy + rustfmt');
  for (const m of components) {
    assert.equal(
      m[2],
      undefined,
      `--component takes one value per flag; found a second bare value '${m[2]?.trim()}'`,
    );
  }
});

test('no flavor bakes a global GOROOT (it would override a setup-go install)', () => {
  // `actions/setup-go` exports GOROOT only for Go < 1.9 (main.ts); for every modern version it
  // just addPath()s the cache entry's bin. So a baked global GOROOT SURVIVES the action and
  // wins: `go` prefers $GOROOT over the directory it was executed from, and a job that pins a
  // different version would drive that binary against the baked version's stdlib. Unset, each
  // `go` derives its own GOROOT from its own path, which is right for both cases.
  const catalog = JSON.parse(read('flavors.json'));
  for (const flavor of catalog.flavors) {
    const instructions = read(flavor.dockerfile)
      .split('\n')
      .filter((l) => !/^\s*#/.test(l));
    for (const line of instructions) {
      assert.doesNotMatch(
        line,
        /^\s*(?:ENV\s+)?GOROOT=/,
        `${flavor.dockerfile}: sets a global GOROOT — put the toolchain's bin on PATH instead`,
      );
    }
  }
  // ...and the go flavor must still reach its prebaked toolchain.
  assert.match(
    read('Dockerfile.go'),
    /PATH=\$\{RUNNER_TOOL_CACHE\}\/go\/\$\{GO_VERSION\}\/arm64\/bin:/,
    'the go flavor must put the cached toolchain bin on PATH',
  );
});

test('the rust flavor gives the job a WRITABLE RUSTUP_HOME', () => {
  // The action this flavor exists to serve (`dtolnay/rust-toolchain`) runs
  // `rustup toolchain install` + `rustup default`, both of which WRITE into RUSTUP_HOME
  // (toolchains/, settings.toml). Root-owned, every workflow that pins a toolchain fails with a
  // permission error. The VM is single-use and runs one job, so there is no later job to poison.
  const df = read('Dockerfile.rust');
  const home = df.match(/^ *(?:ENV )?RUSTUP_HOME=(\S+)/m)?.[1];
  assert.ok(home, 'rust must set RUSTUP_HOME');
  const chowned = [...df.matchAll(/chown -R runner:runner ([^\n\\]+)/g)]
    .flatMap((m) => m[1].trim().split(/\s+/))
    // The Dockerfile chowns through the variable; resolve it so the assertion compares paths.
    .map((p) => p.replace('${RUSTUP_HOME}', home));
  assert.ok(
    chowned.includes(home),
    `RUSTUP_HOME (${home}) must be chowned to the runner user — rustup writes into it`,
  );
});

test('the rust flavor gives the job a WRITABLE CARGO_HOME', () => {
  // cargo
  // ALSO writes the registry index + crate cache into CARGO_HOME. Left pointing at
  // /opt/rust/cargo, every dependency fetch fails with "failed to download replaced source
  // registry `crates-io`: Permission denied (os error 13)" — verified in a container as the
  // unprivileged runner user. The final CARGO_HOME must be under the runner's home.
  const df = read('Dockerfile.rust');
  const values = [...df.matchAll(/^ *(?:ENV )?CARGO_HOME=(\S+)/gm)].map((m) => m[1]);
  assert.ok(values.length >= 1, 'rust must set CARGO_HOME');
  assert.match(
    values[values.length - 1],
    /^\/home\/runner\//,
    'the effective (last) CARGO_HOME must be writable by the runner user',
  );
  // ...and the baked rustup shims must stay reachable.
  assert.match(df, /PATH=\/opt\/rust\/cargo\/bin:/);
});

test('tool-cache paths are derived from the version pin, never a repeated literal', () => {
  // A hardcoded GOROOT/JAVA_HOME/PATH copy of the pinned version silently points at a
  // nonexistent directory the moment the ARG above it is bumped — the image still builds and
  // the flavor ships with a broken default toolchain.
  let inspected = 0;
  for (const name of TOOLCACHE_FLAVORS) {
    const df = read(`Dockerfile.${name}`);
    for (const line of df.split('\n')) {
      if (/^\s*#/.test(line)) continue;
      // Match the cache root in EVERY form it is written: the Dockerfiles reference it as
      // ${RUNNER_TOOL_CACHE}, so a filter that only looked for the literal `hostedtoolcache`
      // string skipped every real instruction and the assertion below could never fire.
      for (const m of line.matchAll(
        /(?:\$\{RUNNER_TOOL_CACHE\}|\$RUNNER_TOOL_CACHE|\/opt\/hostedtoolcache)\/([A-Za-z_][A-Za-z0-9_]*)\/([^\s/\\]+)/g,
      )) {
        inspected += 1;
        const [, toolName, versionSegment] = m;
        assert.doesNotMatch(
          versionSegment,
          /^\d/,
          `${name}: hardcoded ${toolName} version '${versionSegment}' in '${line.trim()}' — ` +
            'derive it from the ARG, or the path silently points at a nonexistent directory ' +
            'the moment the pin is bumped',
        );
      }
    }
  }
  // The guard is only worth anything if it actually looked at the tool-cache paths. Zero
  // inspected means the matcher stopped agreeing with how the Dockerfiles are written.
  assert.ok(
    inspected >= TOOLCACHE_FLAVORS.length,
    `found only ${inspected} tool-cache path(s) to check across ${TOOLCACHE_FLAVORS.length} ` +
      'flavors — the matcher no longer recognizes how these Dockerfiles reference the cache root',
  );
});

test('the node flavor\'s tool-cache pin agrees with its apt NODE_MAJOR', () => {
  // Dockerfile.node carries BOTH pins: NODE_MAJOR drives the nodesource apt repo (the Node the
  // run-hook + the agent's node actions run on) and NODE_VERSION is the tool-cache entry
  // setup-node resolves. If they drift, a `setup-node` with `node-version: 24` gets a cache hit
  // on a major the rest of the image does not have — a comment asking to keep them in sync does
  // not enforce anything.
  const df = read('Dockerfile.node');
  const major = df.match(/ARG NODE_MAJOR=(\d+)/)?.[1];
  const version = df.match(/ARG NODE_VERSION=(\d+)\.\d+\.\d+/)?.[1];
  assert.ok(major && version, 'node must pin both NODE_MAJOR and NODE_VERSION');
  assert.equal(version, major, `NODE_VERSION major (${version}) must match NODE_MAJOR (${major})`);
});

test('this repo\'s own CI asks setup-node for the major the node flavor prebaked', () => {
  // The dogfood workflow runs on `lambda-ci-node` and then calls actions/setup-node. setup-node
  // resolves `node-version` against ${RUNNER_TOOL_CACHE}/node/<semver>/arm64, so a request for a
  // major the image did not bake is a SILENT cache miss: the job downloads Node at full speed
  // and our own CI stops exercising the prebaked cache that ADR-039 exists to provide. Nothing
  // else catches this — the workflow still passes, just slower.
  const baked = read('Dockerfile.node').match(/ARG NODE_MAJOR=(\d+)/)?.[1];
  const ci = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const requested = [...ci.matchAll(/node-version:\s*'?"?(\d+)/g)].map((m) => m[1]);
  assert.ok(requested.length > 0, 'ci.yml should pin a node-version for setup-node');
  for (const want of requested) {
    assert.equal(
      want,
      baked,
      `ci.yml asks setup-node for Node ${want} but the node flavor prebakes ${baked} — that is a ` +
        'silent tool-cache miss; bump one to match the other',
    );
  }
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

test('no flavor description advertises a vCPU shape (ADR-038)', () => {
  // `description` is rendered VERBATIM under the flavor name on the console's Flavors screen,
  // so it is the most operator-facing string in the catalog. A "4 vCPU / 8 GB" footprint there
  // restates exactly the claim ADR-038 retracts — and it does so on the same page as that
  // screen's own dagger footnote saying vCPU is indicative, so the two disagree in one view.
  // The catalog's `vcpu` FIELD stays (it is the documented tie-break in
  // `smallestWithCapability`); it is the prose promise of provisioned capacity that must not
  // ship. This is the sweep ADR-038 asked for, enforced instead of remembered.
  const catalog = JSON.parse(read('flavors.json'));
  for (const flavor of catalog.flavors) {
    assert.doesNotMatch(
      flavor.description,
      /vcpu/i,
      `flavor ${flavor.name}: description names a vCPU count — the API accepts no vCPU ` +
        'request (ADR-038). State the requested memory instead.',
    );
  }
});
