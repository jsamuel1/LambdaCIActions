# syntax=docker/dockerfile:1
#
# Dockerfile.go — the `go` flavor microVM image (docs/specs/02-microvm-runners.md,
# capabilities: ["go"]). Base runner + a pinned Go toolchain, installed INTO the runner tool
# cache so `actions/setup-go@v5` resolves from cache instead of downloading (ADR-039).
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
# Pinned Go. Bump deliberately (ADR-039) — `latest` would make image rebuilds
# non-reproducible.
ARG GO_VERSION=1.25.12
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
      # cgo needs a C toolchain; a Go job that imports anything cgo-backed fails without it.
      build-essential \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# --- go flavor extras -------------------------------------------------------------------
# setup-go caches under toolName `go` (installer.ts `toolCacheName`) and adds
# `<cacheEntry>/bin` to PATH, so the cache entry root must hold the CONTENTS of the release
# tarball's `go/` dir (bin/, pkg/, src/…) — not a nested `go/` dir. Hence --strip-components=1.
RUN mkdir -p ${RUNNER_TOOL_CACHE}/go/${GO_VERSION}/arm64 \
    && curl -fsSL -o /tmp/go.tar.gz \
       "https://go.dev/dl/go${GO_VERSION}.linux-arm64.tar.gz" \
    && tar -xzf /tmp/go.tar.gz -C ${RUNNER_TOOL_CACHE}/go/${GO_VERSION}/arm64 --strip-components=1 \
    # The completion marker is a SIBLING of the arch dir, not a file inside it
    # (@actions/tool-cache `_completeToolPath`). Without it the entry is invisible and every
    # job re-downloads the toolchain.
    && touch ${RUNNER_TOOL_CACHE}/go/${GO_VERSION}/arm64.complete \
    && rm /tmp/go.tar.gz \
    # Fail the BUILD (not a job) if the layout is wrong.
    && ${RUNNER_TOOL_CACHE}/go/${GO_VERSION}/arm64/bin/go version
# Put the cached toolchain on PATH so plain `go build`/`go test` steps work with no setup-*
# action at all. GOPATH lives under the runner's home so a job can write modules without sudo.
#
# GOROOT is deliberately NOT exported. `actions/setup-go` only sets GOROOT for Go < 1.9
# (main.ts) — for every modern version it just `addPath`s the cache entry's `bin`. A baked
# global GOROOT therefore survives the action and WINS: the `go` command prefers $GOROOT over
# the location it was executed from, so a job running `setup-go` with any version other than
# the pin would drive that version's binary against THIS version's stdlib. Left unset, each
# `go` binary derives its own GOROOT from its path — correct for both the prebaked toolchain
# and any setup-go install. The PATH entry is derived from ${GO_VERSION} rather than repeated
# as a literal: a hardcoded copy silently points at a nonexistent directory the moment the pin
# is bumped.
ENV GOPATH=/home/runner/go
ENV PATH=${RUNNER_TOOL_CACHE}/go/${GO_VERSION}/arm64/bin:${GOPATH}/bin:$PATH
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
    && mkdir -p ${GOPATH} \
    && chown -R runner:runner ${RUNNER_DIR} ${RUNNER_TOOL_CACHE} ${GOPATH}

USER runner
WORKDIR ${RUNNER_DIR}

EXPOSE 8080
# Entrypoint is the run-hook server; it blocks until /run then supervises the single job.
ENTRYPOINT ["node", "/opt/actions-runner/run-hook.mjs"]
