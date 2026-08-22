#!/usr/bin/env bash
# RUN THE SNAPSHOT ON A TIMER, SO NOBODY HAS TO REMEMBER.
#
# .husky/reference-transaction now makes it impossible for a reset to orphan a
# local COMMIT. That leaves the other half: work that has not been committed at
# all. `git reset --hard` discards tracked modifications outright, and an agent
# mid-edit has no warning and no reflog entry to recover from.
#
# scripts/agent-trees-snapshot.sh captures that state without touching anything.
# This installs it as a launchd agent so it runs every ten minutes across every
# repo on this machine. Worst case you lose ten minutes; today you lose the
# session.
#
#   bash scripts/install-wip-snapshot-agent.sh            # install + start
#   bash scripts/install-wip-snapshot-agent.sh --status   # is it running
#   bash scripts/install-wip-snapshot-agent.sh --uninstall
#
# It is deliberately a launchd agent and not an Open Claw job or a GitHub
# Actions schedule: it reads working trees that exist only on this Mac, and the
# repo rules (World Hub CLAUDE.md section 11) reserve those schedulers for
# application logic. This is a developer-machine safety net.
set -uo pipefail

LABEL="poker.agent-wip-snapshot"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG="$HOME/Library/Logs/${LABEL}.log"
INTERVAL="${WIP_SNAPSHOT_INTERVAL:-600}"

case "${1:-install}" in
  --status)
    launchctl list | grep -q "$LABEL" && echo "running (every ${INTERVAL}s)" || echo "NOT installed"
    echo "plist: $PLIST"
    echo "log:   $LOG"
    [ -f "$LOG" ] && { echo "--- last 20 log lines ---"; tail -20 "$LOG"; }
    exit 0 ;;
  --uninstall)
    launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "uninstalled. Existing refs/wip/* snapshots are untouched."
    exit 0 ;;
esac

# Every repo that has the snapshot script. Discovered, not hard-coded, so a new
# repo is covered the moment it carries the script rather than the moment
# somebody remembers to edit a list.
RUNNER="$HOME/Library/Application Support/poker-agent-wip-snapshot.sh"
mkdir -p "$(dirname "$RUNNER")"
cat > "$RUNNER" <<'RUN'
#!/usr/bin/env bash
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
for repo in "$HOME"/Documents/*/; do
  [ -d "$repo/.git" ] || continue
  [ -f "$repo/scripts/agent-trees-snapshot.sh" ] || continue
  OUT=$(cd "$repo" && bash scripts/agent-trees-snapshot.sh 2>&1)
  case "$OUT" in
    *"nothing to capture"*) : ;;              # silence is the normal case
    *) printf '%s:\n%s\n' "$(basename "$repo")" "$OUT" ;;
  esac
  (cd "$repo" && bash scripts/agent-trees-snapshot.sh --prune >/dev/null 2>&1) || true
done
RUN
chmod +x "$RUNNER"

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>${RUNNER}</string></array>
  <key>StartInterval</key><integer>${INTERVAL}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
PL

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"
launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>/dev/null || true

echo "installed: ${LABEL}, every ${INTERVAL}s, log at ${LOG}"
echo "check it with: bash scripts/install-wip-snapshot-agent.sh --status"
