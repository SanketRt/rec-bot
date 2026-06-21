# rec-bot

A recording bot for online lectures. You give it a Google Meet link (or a
schedule of them); it joins the call, records the whole thing in clean quality,
and saves the video — so a lecture recording never depends on someone remembering
to hit "record" or on a noisy room microphone.

Built for ANCC's Algorithms & Competitive Programming sessions.

> Want to know how it works under the hood? See **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Why use it

Recordings made by a person in a room keep going wrong — audio not captured,
background noise, low quality. This bot fixes that by recording the **call
itself** instead of a room: it hears exactly what each speaker's microphone
sends and sees exactly what's shared on screen. No room noise, nothing to
forget, the same quality every time.

## What you need

- A computer or small server that can stay on during lectures (your own machine,
  or a cheap/free cloud VM — see [Running it on a server](#running-it-on-a-server)).
- **Docker** installed.
- A **dedicated Google account** for the bot (e.g. `ancc-recorder@…`). Don't use a
  personal account you also attend meetings with — the bot needs to be a separate
  participant.

## Set it up (one time)

**1. Get the code**

```bash
git clone git@github.com:SanketRt/rec-bot.git
cd rec-bot
```

**2. Create your settings file**

```bash
cp .env.example .env
```

Open `.env` and set a couple of things (everything else has good defaults):

- `BROWSER_CHANNEL=chrome` — leave this on.
- Where recordings should go later — `UPLOAD_TARGET` (`local` keeps them on disk;
  `drive` or `youtube` upload them — see [Saving recordings](#saving-recordings)).

**3. Sign the bot in (once)**

The bot stays logged into its Google account so it can join meetings. Sign in one
time on a computer with a screen:

```bash
npm install
node scripts/signin.mjs        # a Chrome window opens — log in as the bot account
```

A Chrome window opens; log in with the **bot's** Google account and close it when
done. The login is saved and reused from then on.

> If your lectures are IIT Delhi org meetings, sign in with an **IITD account** —
> org meetings usually let the bot in automatically, with no one having to admit it.

**4. Build and start it**

```bash
docker compose up -d --build
```

That's it — the bot is now running and watching your schedule.

## Recording lectures

You have three ways to use it. Pick whichever fits.

### A. Tell it your schedule (recommended)

Create a file `data/schedule.json` listing your lectures (copy the example):

```bash
cp data/schedule.json.example data/schedule.json
```

```json
[
  {
    "title": "Algorithms Lecture 3",
    "meetUrl": "https://meet.google.com/abc-defg-hij",
    "startsAt": "2026-06-21T18:00:00+05:30",
    "endsAt":   "2026-06-21T20:00:00+05:30"
  }
]
```

The bot joins a couple of minutes before each lecture, records it, and leaves
when it ends. You can edit this file anytime — no restart needed.

### B. Use a Google Calendar

If your lectures live on a calendar, point the bot at it and it records every
event that has a Meet link automatically. See
[Connecting a calendar](#connecting-a-google-calendar).

### C. Record one meeting right now

```bash
docker compose exec rec-bot node dist/cli.js record https://meet.google.com/abc-defg-hij --title "Algo Lec 3"
```

Either way, **if the meeting isn't an org meeting, someone already in the call has
to click "Admit"** when the bot ("ANCC Recording") knocks.

## Where recordings go

Finished videos land in the `data/recordings/` folder as `.mp4` files, named with
the date and lecture title. They're normal video files — open them in any player.

## Saving recordings

By default recordings stay on the machine. To upload them automatically, set
`UPLOAD_TARGET` in `.env`:

- **`drive`** — upload to Google Drive. Set `RCLONE_REMOTE` and provide an rclone
  config (see comments in `docker-compose.yml`). Best for large lectures.
- **`youtube`** — upload as an unlisted YouTube video. Run the one-time helper
  `node scripts/google-auth.mjs` to connect a YouTube account.

Set `DELETE_AFTER_UPLOAD=true` if you want the local copy removed after a
successful upload.

## Everyday commands

```bash
docker compose up -d            # start (or restart) the bot
docker compose down             # stop it
docker compose logs -f          # watch what it's doing
curl localhost:8080/health      # quick "is it alive?" check
```

Record now / stop, over the simple web API:

```bash
# start recording a link
curl -X POST localhost:8080/record -H 'content-type: application/json' \
  -d '{"meetUrl":"https://meet.google.com/abc-defg-hij","title":"Algo Lec 3"}'

# see what's recording
curl localhost:8080/recordings

# stop everything
curl -X POST localhost:8080/stop -d '{}'
```

## Connecting a Google Calendar

1. In `.env`, set `SCHEDULE_SOURCE=gcal` and `GCAL_CALENDAR_ID` to the calendar
   that has your lectures.
2. Connect a Google account once: `node scripts/google-auth.mjs` and follow the
   prompt; paste the value it prints into `.env`.
3. Restart: `docker compose up -d`.

Now any calendar event with a Meet link gets recorded automatically.

## Running it on a server

So it records even when your laptop is off, run it on an always-on machine. A
free **Oracle Cloud "Always Free"** VM works well. The setup is the same:

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
git clone git@github.com:SanketRt/rec-bot.git && cd rec-bot
cp .env.example .env     # edit it
node scripts/signin.mjs  # do this on a machine with a screen, then copy the data/ folder up
docker compose up -d --build
```

> One note: real Google Chrome only exists for regular (Intel/AMD) machines. On
> ARM servers (like Oracle's free tier) the bot falls back to a built-in browser —
> see [ARCHITECTURE.md](ARCHITECTURE.md#browsers-versions-and-the-login-profile)
> for the caveat.

## If something goes wrong

- **The bot couldn't join / "you can't join this call".** The bot's account must
  be *different* from whoever is hosting, and someone has to admit it (unless it's
  an org meeting). Check `data/logs/` — the bot saves a screenshot of the exact
  screen it got stuck on.
- **It says it's logged out.** Re-run `node scripts/signin.mjs`. Make sure you set
  `BROWSER_CHANNEL=chrome`.
- **Audio is missing or quiet.** Confirm the speaker was actually talking and
  unmuted. The bot records the call's audio directly, so a silent call records
  silence.
- **It joined but recorded the wrong thing.** Ask presenters to "pin" or
  "spotlight" their screen share so it fills the frame — that's what gets recorded
  at full quality.

For anything deeper, the technical guide explains every part:
**[ARCHITECTURE.md](ARCHITECTURE.md)**.

## All settings

Every option is documented with its default in **[`.env.example`](.env.example)**.
The ones you're most likely to touch: `UPLOAD_TARGET`, `SCHEDULE_SOURCE`,
`MAX_DURATION_MIN`, `BOT_NAME`.
