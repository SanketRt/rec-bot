# Architecture & Design

How rec-bot works under the hood, why it's built this way, and the non-obvious
things learned getting it to actually record real Google Meet calls.

For setup and day-to-day use, see [README.md](README.md).

---

## The core idea

Every recurring failure of human-made recordings — missed audio, room noise, low
quality — comes from capturing a **microphone in a room**. rec-bot captures the
**digital Meet stream** instead: each speaker's microphone as Meet transmits it,
and the exact pixels of the shared screen. So there's no room noise, nothing to
forget, and consistent quality.

Concretely, the bot is a real Chrome browser, driven by automation, running on a
virtual screen inside a container. Meet plays the call's audio into a virtual
speaker; a screen recorder captures that virtual screen and virtual speaker into
one file.

## Big picture

```
            ┌──────────────────────── Docker container ──────────────────────── ─┐
            │                                                                    │
 Meet  ───► │   Chrome (headed, on a virtual display :99)                        │
 link       │      ▲  Playwright drives it: open link, mute, join                │
            │      │                                                             │
            │      │  audio out                          screen + audio          │
            │      ▼                                          │                  │
            │   PulseAudio null sink  ──(.monitor)──►  ffmpeg (x11grab + pulse)  │
            │   (clean digital mix)                          │                   │
            │                                                ▼                   │
            │   session orchestrator   ───────────►   raw .mkv ──► final .mp4    │
            │   (join · watch · leave)                 (resilient)  (loudnorm,   │
            │      ▲           ▲                                     trim,       │
            │      │           │                                     faststart)  │
            │   scheduler    HTTP API                                  │         │
            │   (file/gcal)  (/record …)                               ▼         │
            │                                                  upload (local/    │
            │                                                  Drive/YouTube)    │
            └────────────────────────────────────────────────────────────────────┘
```

## Components

| Area | File | Responsibility |
|------|------|----------------|
| Entry point | `src/cli.ts` | Dispatch `record` / `serve` / `schedule` / `all`; signal handling. |
| Config | `src/config.ts` | All settings from env, validated with zod. |
| Session | `src/session.ts` | One recording end-to-end; owns graceful shutdown. |
| Manager | `src/manager.ts` | Concurrency cap + dedup across triggers. |
| HTTP API | `src/server.ts` | `/record`, `/stop`, `/recordings`, `/health`. |
| Browser | `src/bot/browser.ts` | Launch headed Chrome with the right flags + audio routing. |
| Join | `src/bot/join.ts` | Green-room → admission flow. |
| Monitor | `src/bot/monitor.ts` | Live read of participants / screen-share / presence. |
| Selectors | `src/bot/selectors.ts` | **All** Meet UI lookups, with fallbacks. |
| Recorder | `src/recorder/ffmpeg.ts` | Capture the display + sink into a `.mkv`. |
| Post-process | `src/recorder/postprocess.ts` | Loudness-normalize, trim, remux to `.mp4`, transcribe. |
| Scheduler | `src/scheduler/*` | Poll a file or Google Calendar; start sessions on time. |
| Upload | `src/upload/*` | Pluggable: local / Drive (rclone) / YouTube. |
| Boot | `docker/entrypoint.sh` | Start the virtual display + audio, then the app. |

## The recording lifecycle

A `Session` walks through a small state machine and **always finalizes a playable
file**, whatever the exit reason.

```
launch browser ─► join ──(fail)──► save screenshot ─► error end
      │
      ▼ (admitted)
 start ffmpeg ─► WATCH LOOP ─► leave ─► stop ffmpeg ─► finalize ─► transcribe ─► upload
                    │
   every heartbeat the loop ends on one of:
     • meeting-empty        (participants ≤ threshold past a grace period)
     • max-duration         (hard safety cap)
     • removed-from-meeting (kicked, or the call ended)
     • manual-stop          (SIGTERM / API /stop)
     • browser-crashed      (page closed unexpectedly)
```

Why this matters: the auto-leave path, a `docker stop`, and a crash all converge
on the same clean shutdown, so you never get a half-written video.

## Design decisions (and why)

### Headed Chrome on a virtual display, not headless
Fully headless Chromium is fingerprinted and frequently blocked by Meet. The bot
runs a **real, headed Chrome** against an `Xvfb` virtual display (`:99`), which is
indistinguishable from a normal desktop browser. A tiny window manager (`fluxbox`)
gives Chrome a proper full-screen window so the capture is full-frame.

### Audio via a PulseAudio null sink
The container creates a virtual "speaker" (a null sink). Meet plays all remote
audio into it; we record its **monitor** (the mixed digital output). This is the
key trick — we capture what the call *sounds like*, not a microphone, so there's
zero room noise and nothing depends on input devices (the bot has none, and stays
muted). Verified at runtime: Chrome shows up as a playback stream on the sink at
100% volume.

### Capture to Matroska, finalize to MP4
ffmpeg records the raw capture as **`.mkv`**, which stays playable even if the
process is killed mid-write. A non-faststart `.mp4` would only be valid after a
clean exit. Post-processing then remuxes to a streamable `.mp4` (`+faststart`),
applies **EBU R128 loudness normalization** (consistent volume across lectures),
and optionally trims leading/trailing silence. Video is stream-copied (no
re-encode), so finalize is fast. If finalize ever fails, it falls back to a plain
remux so the recording is never lost.

### Capture settings
1920×1080 @ 30fps, `libx264` CRF 23 `veryfast`, `yuv420p`, keyframe every 2s;
audio AAC 192k @ 48kHz stereo. No GPU needed — software H.264 handles one 1080p30
stream on ~2 vCPUs.

### Resilient selectors
Meet ships obfuscated class names that change often. Every UI lookup lives in
`src/bot/selectors.ts` as an **ordered list of fallback strategies** (accessible
role/name, aria-label, visible text, stable attributes); the first that resolves
wins. When Meet changes its UI, you usually add one new candidate there rather
than touch any logic. Join failures auto-save a screenshot to `data/logs/` so you
can see exactly what changed.

### Lifecycle robustness
- **Empty-room detection** with a startup grace period (so a late lecturer doesn't
  trigger an immediate leave) and a sustained-empty grace before leaving.
- **Hard duration cap** as a safety net.
- **Transient-disconnect tolerance** — a few missed heartbeats before concluding
  the bot was removed.
- **Graceful shutdown** — SIGTERM/`/stop` request a stop; the session finishes
  leaving and finalizing before the process exits (the `record` command waits on
  the run to complete rather than exiting from the signal handler).

### Concurrency & dedup
The `SessionManager` enforces one global concurrency cap (`MAX_CONCURRENT`) and
keys sessions by canonical Meet URL, so the scheduler and the API can never
double-join the same meeting.

### Scheduling
Two interchangeable sources behind one interface:
- **File** (`data/schedule.json`) — re-read every poll, so edits apply live.
- **Google Calendar** — any event with a Meet link is recorded; `endsAt` derives a
  max duration.

### Upload
A small `Uploader` interface with a factory. `local` (keep on disk), `drive` (via
the `rclone` binary — resumable, chunked, retrying; best for big/flaky uploads),
and `youtube` (resumable OAuth upload). Optional delete-after-upload.

## Browsers, versions, and the login profile

This is the subtle part, learned the hard way during testing.

1. **Google blocks its automation browser for *login*.** Signing into a Google
   account in Playwright's bundled Chromium triggers "this browser may not be
   secure." Real Google Chrome is accepted. So sign-in **must** use real Chrome
   (`scripts/signin.mjs` with `BROWSER_CHANNEL=chrome`).

2. **A login profile only loads in an equal-or-newer browser.** A profile written
   by Chrome 149 is rejected by an older Chromium (it reads **zero** cookies). So
   the browser that *records* must be at least as new as the one that signed in.
   Playwright's bundled Chromium lags Chrome stable, so we run **real Chrome in the
   container too** (`BROWSER_CHANNEL=chrome`), installed in the image on `amd64`.

3. **Portable cookies.** Both sign-in and the bot launch Chrome with
   `--password-store=basic`, so cookies are encrypted with a fixed key (not the OS
   keyring) and decrypt inside the container.

4. **ARM caveat.** Google ships no Chrome for arm64. On ARM (e.g. Oracle's free
   tier) the image falls back to Playwright's bundled Chromium — leave
   `BROWSER_CHANNEL` unset. The login-profile compatibility above then constrains
   you to signing in with a matching-version Chromium; the simplest robust setup is
   an `amd64` host where real Chrome is available.

## File ownership (uid mapping)

Inside the Playwright image the app user is **uid 1001**, but host files are
typically **uid 1000**. With a bind-mounted `data/`, that mismatch makes the
container unable to read the (0700) login profile, and recordings come out owned
by 1001. The container is therefore run as the host's uid/gid (compose `user:`
with a writable `HOME`), so it reads the profile and writes recordings you own.

## A bot is a second participant

Two operational truths that aren't bugs:
- The bot's Google account must be **different** from anyone hosting/attending —
  otherwise Meet says "you're already in this call" and offers to *switch* the
  session instead of joining.
- **Anonymous** join (no login) is auto-rejected on consumer meetings. Use a
  signed-in, separate account; for IITD org meetings, an org account is
  auto-admitted with no human in the loop.

## Maintenance

- **Selectors** are the one part that needs occasional upkeep when Meet changes
  its UI. Add a candidate in `src/bot/selectors.ts`; the failed-join screenshot in
  `data/logs/` shows what to match.
- **Keep Playwright and the base image in lockstep** — the image tag bundles the
  exact Chromium build the pinned `playwright` version expects (see the comment in
  the `Dockerfile`).
- **Real Chrome auto-updates** in the image; since it only needs to be ≥ the
  sign-in version, that's fine. Re-run sign-in if the account is ever logged out.

## Configuration reference

Every option is an environment variable documented in
[`.env.example`](.env.example), grouped by area (display/quality, identity,
lifecycle, paths, post-processing, upload, API, scheduler).
