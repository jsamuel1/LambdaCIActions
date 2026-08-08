# syntax=docker/dockerfile:1
#
# Dockerfile.java — the `java` flavor microVM image (docs/specs/02-microvm-runners.md,
# capabilities: ["java"]). Base runner + a pinned Temurin JDK LTS, installed INTO the runner
# tool cache so `actions/setup-java@v4` resolves from cache instead of downloading (ADR-039).
#
# This Dockerfile is self-contained (create-microvm-image builds a snapshot from a single
# staged `Dockerfile`, not from a registry image), so it mirrors Dockerfile.base and then
# layers the extra toolchain on top. Keep the base layers in sync with Dockerfile.base.
#
# HARD RULE (AGENTS.md): arm64 ONLY. Lambda microVMs are Graviton-only — the base image,
# the runner agent tarball, and every binary below must be arm64. Do NOT switch to an
# x86_64 base or the snapshot build will produce an unbootable image.
FROM --platform=linux/arm64 ubuntu:22.04

ARG RUNNER_VERSION=2.335.1
ARG NODE_MAJOR=24
# Pinned Eclipse Temurin JDK 21 (LTS), aarch64. JDK_BUILD is the Adoptium build number:
# the release is `jdk-<JDK_VERSION>+<JDK_BUILD>`. Bump deliberately (ADR-039) — `latest`
# would make image rebuilds non-reproducible.
ARG JDK_VERSION=21.0.12
ARG JDK_BUILD=8
ENV DEBIAN_FRONTEND=noninteractive \
    RUNNER_DIR=/opt/actions-runner \
    RUN_HOOK_PORT=8080 \
    # The runner resolves its tool cache from RUNNER_TOOL_CACHE and otherwise falls back to
    # `_work/_tool` (actions/runner HostContext.cs WellKnownDirectory.Tools) — a self-hosted
    # runner does NOT default to /opt/hostedtoolcache. Setting it here is what makes the
    # prebaked cache below the cache the agent actually consults.
    RUNNER_TOOL_CACHE=/opt/hostedtoolcache \
    AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache

# Common toolchain + the runner agent's runtime deps. Node is needed both for the
# run-hook server and for the GitHub Actions runner's node-based actions.
# `awscli` is apt's aws-cli **v1** — the CLI ADR-028 measures the cold boot cost against.
# See Dockerfile.base for why v1 is correct here and what to re-check before changing it.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq unzip tar gzip sudo \
      libicu70 lsb-release awscli \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# --- java flavor extras -----------------------------------------------------------------
# Lay the JDK out exactly where setup-java looks: it reads
# ${RUNNER_TOOL_CACHE}/Java_<distribution>_<packageType>/<version>/<arch> (base-installer.ts
# `toolcacheFolderName` + util.ts `getToolcachePath`), and the arch is `arm64` (os.arch() on
# Graviton).
#
# `<distribution>` is NOT the `distribution:` workflow input. It is the installer class's own
# name, and temurin's constructor is `super(`Temurin-${jvmImpl}`, ...)` with jvmImpl defaulting
# to `hotspot`, so the folder is `Java_Temurin-Hotspot_jdk`. Baking the input's spelling
# (`Java_temurin_jdk`) puts the JDK somewhere findAllVersions() never scans: setup-java then
# logs `Trying to download...` and re-fetches the whole JDK on EVERY job while the job still
# goes green — the exact silent failure this cache exists to prevent. Verified live on
# lca-dev-java before this fix (run 31261348449): setup-java ignored the baked entry and
# installed to .../Java_Temurin-Hotspot_jdk/21.0.12-8.0.LTS/arm64.
ARG JDK_TOOLCACHE_NAME=Java_Temurin-Hotspot_jdk
#
# The version DIRECTORY uses `-` where the JDK version uses `+` (setup-java stores
# `21.0.12+8` as `21.0.12-8` and maps it back when scanning with `replace('-', '+')`, because a
# `+` in JAVA_HOME breaks some toolchains). Getting this wrong means findAllVersions() skips
# the entry — it must also be valid semver or it is ignored outright.
RUN mkdir -p ${RUNNER_TOOL_CACHE}/${JDK_TOOLCACHE_NAME}/${JDK_VERSION}-${JDK_BUILD}/arm64 /tmp/jdk \
    && curl -fsSL -o /tmp/jdk.tar.gz \
       "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-${JDK_VERSION}%2B${JDK_BUILD}/OpenJDK21U-jdk_aarch64_linux_hotspot_${JDK_VERSION}_${JDK_BUILD}.tar.gz" \
    && tar -xzf /tmp/jdk.tar.gz -C /tmp/jdk --strip-components=1 \
    && cp -R /tmp/jdk/. ${RUNNER_TOOL_CACHE}/${JDK_TOOLCACHE_NAME}/${JDK_VERSION}-${JDK_BUILD}/arm64/ \
    # The completion marker is a SIBLING of the arch dir, not a file inside it
    # (@actions/tool-cache `_completeToolPath`). Without it the entry is invisible and every
    # job re-downloads the JDK.
    && touch ${RUNNER_TOOL_CACHE}/${JDK_TOOLCACHE_NAME}/${JDK_VERSION}-${JDK_BUILD}/arm64.complete \
    && rm -rf /tmp/jdk /tmp/jdk.tar.gz \
    # Fail the BUILD (not a job) if the layout is wrong.
    && ${RUNNER_TOOL_CACHE}/${JDK_TOOLCACHE_NAME}/${JDK_VERSION}-${JDK_BUILD}/arm64/bin/java -version
# Make the cached JDK the default so plain `java`/`javac` steps work with no setup-*
# action at all. setup-java sets these itself when it runs; these are the no-action defaults.
# Derived from the pins rather than repeated as a literal — a hardcoded copy silently points
# at a nonexistent directory the moment JDK_VERSION/JDK_BUILD is bumped.
ENV JAVA_HOME=${RUNNER_TOOL_CACHE}/${JDK_TOOLCACHE_NAME}/${JDK_VERSION}-${JDK_BUILD}/arm64
ENV PATH=${JAVA_HOME}/bin:$PATH
# ----------------------------------------------------------------------------------------

# GitHub Actions runner agent (arm64). Pinned version — bump deliberately on patch day.
RUN mkdir -p ${RUNNER_DIR} \
    && curl -fsSL -o /tmp/runner.tar.gz \
       https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-arm64-${RUNNER_VERSION}.tar.gz \
    && tar -xzf /tmp/runner.tar.gz -C ${RUNNER_DIR} \
    && rm /tmp/runner.tar.gz \
    && ${RUNNER_DIR}/bin/installdependencies.sh

# The lifecycle-hook server (ADR-012). It receives the JIT config via POST /run and
# launches the runner agent for exactly one job, then self-terminates.
COPY bootstrap/run-hook.mjs ${RUNNER_DIR}/run-hook.mjs

# The runner must NOT run as root (agent refuses); create an unprivileged user that owns
# the runner dir and can sudo for job steps that need it.
RUN useradd -m -s /bin/bash runner \
    && echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner \
    && chown -R runner:runner ${RUNNER_DIR} ${RUNNER_TOOL_CACHE}

USER runner
WORKDIR ${RUNNER_DIR}

EXPOSE 8080
# Entrypoint is the run-hook server; it blocks until /run then supervises the single job.
ENTRYPOINT ["node", "/opt/actions-runner/run-hook.mjs"]
