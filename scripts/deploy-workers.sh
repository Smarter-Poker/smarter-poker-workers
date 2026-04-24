#!/usr/bin/env bash
# deploy-workers.sh — deploy the latest workers container to the Hetzner CPX21 VM
#
# Usage:
#   bash scripts/deploy-workers.sh              # pull :latest, restart, verify
#   bash scripts/deploy-workers.sh --release    # trigger release.yml first (so :latest matches HEAD)
#   bash scripts/deploy-workers.sh --tag v1.2.3 # pull a specific tag instead of :latest
#
# Prerequisites (set up by the Phase 2B.1-deploy AG prompt):
#   SSH key:                ~/.ssh/workers_ed25519
#   Keychain:               smarter-poker/workers-server-ip
#                           smarter-poker/workers-server-id
#                           smarter-poker/github-pat-ghcr-read  (PAT with read:packages)
#   Files on VM:            /opt/workers/docker-compose.yml
#                           /opt/workers/.env  (0600, workers:workers)
#   Image in GHCR:          ghcr.io/smarter-poker/smarter-poker-workers:latest
#   Container name:         smarter-poker-workers
#
# Exit codes:
#   0 — success
#   1 — local prereq missing (keys, Keychain entries)
#   2 — ssh / docker error
#   3 — /health probe failed after restart
#   4 — image fetch failed (release workflow never made :latest etc.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_KEY="$HOME/.ssh/workers_ed25519"
SERVICE_NAME="smarter-poker-workers"
IMAGE="ghcr.io/smarter-poker/smarter-poker-workers"

log() { echo "[deploy-workers] $*"; }
die() { echo "[deploy-workers] ERROR: $*" >&2; exit "${2:-1}"; }

# ─── Parse args ────────────────────────────────────────────────────────────────

TRIGGER_RELEASE=0
IMAGE_TAG="latest"

while [ $# -gt 0 ]; do
  case "$1" in
    --release) TRIGGER_RELEASE=1 ;;
    --tag) shift; IMAGE_TAG="$1" ;;
    -h|--help) head -30 "$0" | grep -E '^#' | cut -c3-; exit 0 ;;
    *) die "unknown flag: $1" ;;
  esac
  shift
done

# ─── Prereq checks ─────────────────────────────────────────────────────────────

[ -f "$SSH_KEY" ] || die "SSH key missing at $SSH_KEY (run Phase 2B.1-deploy AG prompt first)" 1

SERVER_IP=$(security find-generic-password -a smarter-poker -s workers-server-ip -w 2>/dev/null) \
  || die "Keychain entry 'smarter-poker/workers-server-ip' missing" 1
SERVER_ID=$(security find-generic-password -a smarter-poker -s workers-server-id -w 2>/dev/null || echo "")

GH_PAT=$(security find-generic-password -a smarter-poker -s github-pat-ghcr-read -w 2>/dev/null) \
  || die "Keychain entry 'smarter-poker/github-pat-ghcr-read' missing (PAT with read:packages scope)" 1

log "Target:     $SERVER_IP (id=${SERVER_ID:-unknown})"
log "Image tag:  $IMAGE_TAG"

# ─── 1. Optionally trigger a release build first ──────────────────────────────

if [ "$TRIGGER_RELEASE" = "1" ]; then
  log "Triggering release.yml workflow to build + push :$IMAGE_TAG from origin/main..."

  DISPATCH_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Authorization: Bearer $GH_PAT" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/Smarter-Poker/smarter-poker-workers/actions/workflows/release.yml/dispatches" \
    -d "{\"ref\":\"main\"}")

  [ "$DISPATCH_HTTP" = "204" ] || die "release.yml dispatch failed (HTTP $DISPATCH_HTTP)" 4

  # Poll the most recent release run until it completes
  log "Waiting for release workflow to finish..."
  sleep 10
  for i in $(seq 1 30); do
    RUN_JSON=$(curl -s \
      -H "Authorization: Bearer $GH_PAT" \
      "https://api.github.com/repos/Smarter-Poker/smarter-poker-workers/actions/workflows/release.yml/runs?per_page=1")
    STATUS=$(echo "$RUN_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['workflow_runs'][0]['status'])")
    CONCLUSION=$(echo "$RUN_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['workflow_runs'][0].get('conclusion') or '')")
    log "[$i] release status=$STATUS conclusion=$CONCLUSION"
    if [ "$STATUS" = "completed" ]; then
      [ "$CONCLUSION" = "success" ] || die "release.yml conclusion=$CONCLUSION — image build failed" 4
      break
    fi
    sleep 20
  done
fi

# ─── 2. Verify the image tag exists in GHCR ────────────────────────────────────

log "Verifying ghcr.io/smarter-poker/smarter-poker-workers:$IMAGE_TAG exists..."
GHCR_CHECK=$(curl -s \
  -H "Authorization: Bearer $GH_PAT" \
  "https://api.github.com/users/Smarter-Poker/packages/container/smarter-poker-workers/versions?per_page=20")
if ! echo "$GHCR_CHECK" | python3 -c "
import sys, json
d = json.load(sys.stdin)
target = '$IMAGE_TAG'
hit = any(target in (v.get('metadata',{}).get('container',{}).get('tags') or []) for v in d if isinstance(v, dict))
sys.exit(0 if hit else 1)
" 2>/dev/null; then
  die "tag :$IMAGE_TAG not found in GHCR — run with --release to build it" 4
fi

# ─── 3. Pull + restart on the VM ───────────────────────────────────────────────

RESTART_TS=$(date -u +"%Y-%m-%d %H:%M:%S")
log "Deploying at $RESTART_TS UTC..."

ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "root@$SERVER_IP" bash -se -- "$IMAGE_TAG" << 'REMOTE'
set -euo pipefail
IMAGE_TAG="${1:-latest}"
cd /opt/workers

# If the compose file still says :latest but a specific tag was requested,
# override via env (docker-compose interpolates ${IMAGE_TAG} if used; we
# keep it simple here and just pull whatever the compose file says).
if [ "$IMAGE_TAG" != "latest" ]; then
  echo "[remote] NOTE: compose file uses :latest; a non-latest tag requires editing"
  echo "[remote] docker-compose.yml or exporting IMAGE_TAG=... before 'docker compose up'."
  echo "[remote] Proceeding with whatever :latest currently points to."
fi

echo "[remote] docker compose pull"
sudo -u workers docker compose pull

echo "[remote] docker compose up -d"
sudo -u workers docker compose up -d

sleep 5

echo "[remote] container state:"
docker ps --filter "name=smarter-poker-workers" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"
REMOTE

# ─── 4. Verify /health ─────────────────────────────────────────────────────────

log "Probing /health on VM (localhost:8081)..."
for i in 1 2 3 4 5 6; do
  HEALTH=$(ssh -i "$SSH_KEY" "root@$SERVER_IP" 'curl -fsS -m 3 http://127.0.0.1:8081/health 2>/dev/null || echo ""')
  if echo "$HEALTH" | grep -q '"status":"ok"'; then
    log "health OK: $(echo "$HEALTH" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(f"version={d.get(\"version\")} uptime_s={d.get(\"uptime_s\")} heap={d.get(\"memory\",{}).get(\"heapUsedMB\")}MB")')"
    break
  fi
  log "[$i/6] /health not ready, sleeping 5s..."
  sleep 5
  if [ "$i" = "6" ]; then
    ssh -i "$SSH_KEY" "root@$SERVER_IP" "docker logs smarter-poker-workers --tail 80 2>&1 || true"
    die "/health never returned 200 after 30s" 3
  fi
done

# ─── 5. Final scan for ERROR lines in the last 30s of logs ────────────────────

ERRORS=$(ssh -i "$SSH_KEY" "root@$SERVER_IP" \
  "docker logs smarter-poker-workers --since 30s 2>&1 | grep -cE 'ERROR|Exception|uncaughtException|UnhandledPromise' || true")
if [ "${ERRORS:-0}" -gt 0 ]; then
  log "WARN: $ERRORS error-ish lines in last 30s"
  ssh -i "$SSH_KEY" "root@$SERVER_IP" "docker logs smarter-poker-workers --since 30s 2>&1 | grep -E 'ERROR|Exception|uncaughtException|UnhandledPromise' | head -10"
fi

log ""
log "✓ Deploy complete."
log "  Live tail:  ssh -i $SSH_KEY root@$SERVER_IP 'docker logs smarter-poker-workers -f'"
