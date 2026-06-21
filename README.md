# rec-bot

A self-hosted bot that joins Google Meet lectures, records them at full quality,
and (optionally) uploads the result — built for ANCC's Algorithms & Competitive
Programming sessions so a recording never depends on someone remembering to hit
"record" or on a noisy room mic.

## Why a bot fixes the real problem

Every recurring failure — missed audio, room noise, low quality — comes from
capturing a **microphone in a room**. This bot captures the **digital Meet
stream** instead: each speaker's mic and the exact pixels of the shared screen.
Result: zero room noise, nothing to forget, consistent quality every time.

## How it works

```
        ┌─────────────────────── Docker container ───────────────────────┐
        │                                                                 │
 Meet → │  Chromium (headed, in Xvfb)  →  PulseAudio null sink            │
 link   │        ▲ Playwright joins              │ .monitor (clean mix)   │
        │        │                               ▼                        │
        │   join/monitor logic           ffmpeg  (x11grab + pulse)        │
        │        │                               │                        │
        │   scheduler / API ─────────────────────┘→ .mkv → finalize .mp4  │
        │                                              → loudnorm/trim     │
        │                                              → upload (Drive/YT) │
        └─────────────────────────────────────────────────────────────────┘
```

- **Headed Chromium in a virtual display (Xvfb).** Fully headless Chromium is
  fingerprinted and blocked by Meet; a real headed browser on a virtual display
  is indistinguishable from a desktop.
- **PulseAudio null sink.** Meet plays remote audio into a virtual sink; we
  record its *monitor*, i.e. the mixed digital output. No microphone, no room
  noise.
- **ffmpeg** captures the display + the sink monitor into a crash-resilient
  `.mkv`, then post-processing remuxes to a streamable `.mp4`.
- **Resilient selectors.** All Meet UI lookups live in one file
  (`src/bot/selectors.ts`) with multiple fallback strategies, so a Meet UI
  change is usually a one-line fix.

## What makes it solid

- **Crash-resilient capture** — records to Matroska (recoverable even if killed),
  finalizes to `+faststart` MP4 only at the end.
- **Graceful shutdown** — SIGTERM/Ctrl-C and the auto-leave path always finalize
  a playable file (clean ffmpeg `q`, escalating to signals only if needed).
- **Auto start & stop** — joins from a schedule, leaves when the room empties
  (with a startup grace period for a late lecturer) and on a hard duration cap.
- **Loudness-normalized audio** (EBU R128) and optional silence trimming.
- **Three ways to drive it** — one-shot CLI, HTTP API, or calendar/file scheduler.
- **Pluggable upload** — local, Google Drive (rclone, resumable), or YouTube.
- **Debuggable** — structured logs + a screenshot saved on any join failure.

## Quick start (Docker)

```bash
cd ~/Documents/ANCC/rec-bot
cp .env.example .env            # edit as needed
mkdir -p data
docker compose build
docker compose up -d            # runs scheduler + control API (port 8080)
```

### One-off recording (no scheduler)

```bash
# inside the running container:
docker compose exec rec-bot node dist/cli.js record https://meet.google.com/abc-defg-hij --title "Algo Lec 3"

# or via the API:
curl -X POST localhost:8080/record \
  -H 'content-type: application/json' \
  -d '{"meetUrl":"https://meet.google.com/abc-defg-hij","title":"Algo Lec 3"}'
```

Recordings land in `./data/recordings/`.

### First-run: sign the bot in once

Give the bot a **dedicated Google account** (e.g. `ancc-recorder@…`). If it's an
IITD-org account, org meetings usually admit it without a manual "ask to join".
The login is stored in the persistent profile under `data/chrome-profile/`, so
you only do this once:

```bash
# Run a headed Chromium against the container's display to log in interactively,
# OR log in on any machine and copy the resulting profile dir into data/chrome-profile.
```

See [docs: signing in](#signing-the-bot-in) below for the detailed options.

## Running modes

| Command  | What it does                                  |
|----------|-----------------------------------------------|
| `record <url>` | Record one meeting now, then exit (great for testing). |
| `serve`  | Run the HTTP control API only.                |
| `schedule` | Run the scheduler only.                     |
| `all`    | Scheduler **and** API together (default).     |

Local dev (without Docker, needs `Xvfb`, `pulseaudio`, `ffmpeg` on the host):

```bash
npm install
npx playwright install chromium
npm run build
xvfb-run -s "-screen 0 1920x1080x24" node dist/cli.js record <url>
```

## Scheduling

### File-based (default, simplest)

Set `SCHEDULE_SOURCE=file` and drop a `data/schedule.json`
(see `data/schedule.json.example`):

```json
[
  { "title": "Algorithms Lecture 3",
    "meetUrl": "https://meet.google.com/abc-defg-hij",
    "startsAt": "2026-06-21T18:00:00+05:30",
    "endsAt":   "2026-06-21T20:00:00+05:30" }
]
```

The file is re-read every poll, so edits apply without a restart. The bot joins
`GCAL_LOOKAHEAD_MIN` minutes before `startsAt` and uses `endsAt` to set a max
duration.

### Google Calendar (fully hands-off)

Set `SCHEDULE_SOURCE=gcal`, point `GCAL_CALENDAR_ID` at the calendar that holds
your lecture schedule, and provide a Google refresh token (below). Any event
with a Meet link is recorded automatically.

## Upload targets

Set `UPLOAD_TARGET` to one of:

- `local` (default) — keep the file in `data/recordings/`.
- `drive` — upload via **rclone**. Configure a remote (`rclone config`) and set
  `RCLONE_REMOTE=gdrive:ANCC/recordings`; mount your `rclone.conf` (see the
  commented volume in `docker-compose.yml`). Best choice for large/flaky uploads.
- `youtube` — upload as an unlisted video. Needs an OAuth refresh token.

### Getting a Google refresh token (YouTube upload + Calendar)

```bash
# Create a "Desktop app" OAuth client in Google Cloud Console and enable
# "YouTube Data API v3" and/or "Google Calendar API", then:
GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy node scripts/google-auth.mjs
# open the printed URL, authorize, and copy GOOGLE_REFRESH_TOKEN into .env
```

## Signing the bot in

The bot reuses a persistent Chromium profile (`CHROME_USER_DATA_DIR`,
default `data/chrome-profile`). Scripting Google's password form trips its
automation defenses, so log in interactively **once** and reuse the profile:

- **Easiest:** on your laptop, `npx playwright launch` a Chromium with
  `--user-data-dir=$(pwd)/data/chrome-profile`, sign into the recorder account,
  close it, then ship that `data/` dir to the server.
- **On the server:** temporarily expose the container's display (e.g. start a
  VNC server against `:99`) and log in once.

Org-account bots in org meetings often skip the lobby entirely — worth setting up.

## Deploying on Oracle Cloud Always Free

Oracle's Always Free **Ampere A1** (up to 4 ARM cores / 24 GB RAM, free forever)
runs this comfortably — the image is arm64-compatible.

```bash
# on the instance:
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
git clone <your repo> rec-bot && cd rec-bot
cp .env.example .env && nano .env
mkdir -p data
sudo docker compose up -d --build
# open port 8080 in the instance security list only if you need the API remotely
```

No GPU is needed — software H.264 encodes a single 1080p30 stream on ~2 vCPUs.
Budget ~1 vCPU and ~1.5 GB RAM per concurrent recording (`MAX_CONCURRENT`).

## Operational notes

- **Transparency:** the bot appears as a visible participant ("ANCC Recording").
  Announce recording at the start. For your own club's lectures you're on clean
  ground.
- **Slides at full res:** spotlight/pin the presentation in Meet so ffmpeg
  captures slides and code crisply — that's what students rewatch.
- **Maintenance reality:** Meet changes its UI periodically and can break the
  join selectors. That's the real ongoing cost of self-hosting. When it happens,
  add a new candidate in `src/bot/selectors.ts` (check `data/logs/*.png` from the
  failed join for what changed).
- **Backup plan:** keep a Recall.ai account with free credits as cheap insurance
  for high-stakes sessions if the bot ever flakes.

## Project layout

```
src/
  cli.ts                 entry point: record | serve | schedule | all
  config.ts              env config (zod-validated)
  session.ts             one recording, end to end (join→record→leave→finalize→upload)
  manager.ts             concurrency cap + dedup across triggers
  server.ts              HTTP control API
  bot/
    browser.ts           headed Chromium launch (stealth flags, audio routing)
    join.ts              green-room → admission flow
    monitor.ts           live participant/share/presence read
    selectors.ts         resilient Meet selectors (the part that needs upkeep)
  recorder/
    ffmpeg.ts            x11grab + pulse capture to .mkv
    postprocess.ts       loudnorm + silence trim + remux to .mp4, transcription
  scheduler/
    scheduler.ts         poll loop
    fileSource.ts        schedule.json source
    googleCalendar.ts    Google Calendar source
  upload/
    local.ts | drive.ts | youtube.ts
scripts/google-auth.mjs  one-time OAuth refresh-token helper
docker/entrypoint.sh     boots Xvfb + PulseAudio, then the app
```

## Configuration

All options are environment variables documented in `.env.example`. Key ones:
`MAX_DURATION_MIN`, `EMPTY_GRACE_SEC`, `START_GRACE_SEC`, `VIDEO_CRF`,
`UPLOAD_TARGET`, `SCHEDULE_SOURCE`, `MAX_CONCURRENT`.
