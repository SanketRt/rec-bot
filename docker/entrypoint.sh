#!/usr/bin/env bash
# Boots the virtual display + audio stack, then hands off to the Node app.
# Everything here must finish before Chromium/ffmpeg start, or capture fails.
set -euo pipefail

: "${DISPLAY:=:99}"
: "${SCREEN_WIDTH:=1920}"
: "${SCREEN_HEIGHT:=1080}"
: "${PULSE_SINK:=rec_bot_sink}"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-runtime}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

log() { echo "[entrypoint] $*"; }

# 1. Virtual framebuffer display ------------------------------------------------
log "starting Xvfb on $DISPLAY (${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24)"
Xvfb "$DISPLAY" -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24" -nolisten tcp -ac &
for _ in $(seq 1 50); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
log "display ready"

# 2. Window manager so Chromium gets a proper full-screen top-level window ------
fluxbox >/dev/null 2>&1 &

# 3. Audio: a null sink whose *monitor* is the clean digital mix of the call ----
log "starting PulseAudio + null sink '$PULSE_SINK'"
pulseaudio -D --exit-idle-time=-1 --disable-shm=true --log-target=stderr || true
# Give the daemon a moment to come up.
for _ in $(seq 1 25); do
  if pactl info >/dev/null 2>&1; then break; fi
  sleep 0.2
done
pactl load-module module-null-sink sink_name="$PULSE_SINK" \
  sink_properties=device.description="$PULSE_SINK" || true
pactl set-default-sink "$PULSE_SINK" || true
log "audio ready (recording ${PULSE_SINK}.monitor)"

# 4. Hand off (exec so signals reach Node for graceful shutdown) ----------------
log "launching rec-bot: node dist/cli.js $*"
exec node dist/cli.js "$@"
