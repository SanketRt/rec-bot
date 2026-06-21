#!/usr/bin/env node
/**
 * One-time helper to mint a Google OAuth **refresh token** for YouTube uploads
 * and/or Google Calendar scheduling.
 *
 * Prereqs (in Google Cloud Console):
 *   1. Create an OAuth client of type "Desktop app".
 *   2. Enable the "YouTube Data API v3" and/or "Google Calendar API".
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy node scripts/google-auth.mjs
 *
 * It starts a tiny localhost server, prints a URL to open, captures the
 * redirect, and prints GOOGLE_REFRESH_TOKEN for your .env.
 */
import http from "node:http";
import { google } from "googleapis";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const PORT = 53682;
const redirectUri = `http://localhost:${PORT}`;

if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the environment first.");
  process.exit(1);
}

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/calendar.readonly",
];

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // force a refresh_token even on re-auth
  scope: SCOPES,
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("Missing ?code");
    return;
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Success! You can close this tab and return to the terminal.");
    console.log("\n✅  Add this to your .env:\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    if (!tokens.refresh_token) {
      console.log("⚠️  No refresh_token returned. Revoke the app's access and re-run with prompt=consent.");
    }
  } catch (err) {
    res.writeHead(500).end("Token exchange failed: " + err.message);
    console.error(err);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT, () => {
  console.log("\nOpen this URL in your browser and authorize:\n");
  console.log(authUrl + "\n");
  console.log(`Waiting for the redirect on ${redirectUri} ...`);
});
