#!/usr/bin/env bash
# pre-run.docker.sh — the `docker` flavor's per-job pre-run hook.
#
# Baked into the docker-flavor image as ${RUNNER_DIR}/pre-run.sh; run-hook.mjs executes it
# immediately before handing the JIT config to the runner agent. The microVM snapshot has no
# init system, so nothing starts dockerd for us — without this hook `docker version` fails
# with "dial unix /var/run/docker.sock: connect: no such file or directory".
#
# IMPORTANT: the guest kernel sets `no_new_privs`, so `sudo` can never escalate inside a
# microVM ("sudo: The \"no new privileges\" flag is set"). The docker flavor therefore runs
# its entrypoint as ROOT and run-hook.mjs drops to the `runner` user for the agent. This
# hook must consequently already be root — it does not (and cannot) sudo.
#
# arm64 only (AGENTS.md). Dependency-free: bash + tools already in the image.
set -uo pipefail

log() { echo "[pre-run:docker] $*"; }

if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  log "dockerd already running"
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  log "FATAL: not root (uid $(id -u)) — dockerd needs root and sudo cannot escalate under no_new_privs"
  exit 1
fi

mkdir -p /var/log

# The microVM snapshot has no init, so nothing mounts the unified cgroup hierarchy. Without
# it dockerd dies with "failed to start daemon: Devices cgroup isn't mounted". Mount cgroup2
# ourselves (idempotent — a mounted hierarchy exposes cgroup.controllers).
if [ ! -e /sys/fs/cgroup/cgroup.controllers ]; then
  mkdir -p /sys/fs/cgroup
  if mount_err=$(mount -t cgroup2 none /sys/fs/cgroup 2>&1); then
    log "mounted cgroup2 at /sys/fs/cgroup"
  else
    log "WARN: cgroup2 mount failed: ${mount_err}"
  fi
fi
log "cgroup=$(head -1 /proc/self/cgroup) controllers=$(cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null || echo none)"

# `nohup ... &` so dockerd outlives this hook; the runner agent (dropped to `runner`, which
# is in the docker group) talks to /var/run/docker.sock for the rest of the job.
nohup dockerd >/var/log/dockerd.log 2>&1 &

# Wait for the socket to accept API calls. Measured cold start on a Graviton microVM is
# ~35-40s (containerd + plugin init from a cold snapshot), so allow real headroom but still
# fail fast enough to surface a broken daemon with its log rather than burn the VM lifetime.
# (The vCPU count of those runs is not established — the API exposes no vCPU request; see
# ADR-038. The measured range is real, the shape attribution was not.)
deadline=$((SECONDS + 120))
until docker version --format '{{.Server.Version}}' >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    log "dockerd did not become ready within 120s — last 40 lines of /var/log/dockerd.log:"
    tail -n 40 /var/log/dockerd.log 2>/dev/null || log "(no dockerd.log)"
    exit 1
  fi
  sleep 0.5
done

log "dockerd ready in ${SECONDS}s: $(docker version --format '{{.Server.Version}}')"
