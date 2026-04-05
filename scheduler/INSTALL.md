# launchd Install Guide

This bundle runs the Poland visa checker every 2 hours on macOS.

## Generated Files

- Script template: `scheduler/run-check-every-2-hours.sh`
- Plist template: `scheduler/poland-visa-checker.launchagent.plist`
- Stdout log after install: `artifacts/logs/launchd.stdout.log`
- Stderr log after install: `artifacts/logs/launchd.stderr.log`

## Install

```bash
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_TMP="$PROJECT_DIR/scheduler/.poland-visa-checker.launchagent.generated.plist"
sed "s|__PROJECT_DIR__|$PROJECT_DIR|g" "$PROJECT_DIR/scheduler/poland-visa-checker.launchagent.plist" > "$PLIST_TMP"
mkdir -p ~/Library/LaunchAgents
cp "$PLIST_TMP" ~/Library/LaunchAgents/com.poland-visa-checker.plist
launchctl unload ~/Library/LaunchAgents/com.poland-visa-checker.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.poland-visa-checker.plist
launchctl kickstart -k gui/$(id -u)/com.poland-visa-checker
```

## Inspect Status

```bash
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
launchctl print gui/$(id -u)/com.poland-visa-checker
tail -f "$PROJECT_DIR/artifacts/logs/launchd.stdout.log"
tail -f "$PROJECT_DIR/artifacts/logs/launchd.stderr.log"
```

## Remove

```bash
launchctl unload ~/Library/LaunchAgents/com.poland-visa-checker.plist
rm -f ~/Library/LaunchAgents/com.poland-visa-checker.plist
```
