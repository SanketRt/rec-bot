# Playwright's image ships Node 20 + a matched Chromium + all browser libs,
# and is published for both amd64 and arm64 — so the same Dockerfile runs on a
# laptop and on Oracle Cloud's free ARM (Ampere) instances.
# Keep this tag in lockstep with the pinned "playwright" version in package.json
# (the image bundles the exact Chromium build that Playwright version expects).
ARG PW_IMAGE=mcr.microsoft.com/playwright:v1.49.1-noble

# ---- build stage: compile TypeScript -> dist ------------------------------
FROM ${PW_IMAGE} AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage --------------------------------------------------------
FROM ${PW_IMAGE} AS runtime

# Runtime extras the recorder needs:
#   xvfb      - virtual display so Chromium runs *headed* (headless gets blocked)
#   x11-utils - xdpyinfo, to wait until the display is ready
#   fluxbox   - tiny window manager so Chromium sizes/stacks correctly
#   pulseaudio- virtual audio sink whose monitor we capture (zero room noise)
#   ffmpeg    - the actual screen + audio capture and post-processing
#   rclone    - resilient Google Drive uploads
#   dumb-init - PID 1 that forwards SIGTERM to Node for graceful shutdown
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11-utils fluxbox pulseaudio pulseaudio-utils ffmpeg rclone dumb-init ca-certificates \
      wget gnupg \
    && rm -rf /var/lib/apt/lists/*

# Real Google Chrome — Google blocks its bundled Chromium for *account login*,
# and a profile written by host Chrome only loads in an equal-or-newer Chrome.
# Installed on amd64 only (Google ships no arm64 Chrome); on arm64 the image
# falls back to Playwright's bundled Chromium (leave BROWSER_CHANNEL unset).
RUN if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
      wget -qO- https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg && \
      echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list && \
      apt-get update && apt-get install -y --no-install-recommends google-chrome-stable && \
      rm -rf /var/lib/apt/lists/* ; \
    else echo "non-amd64: skipping Chrome, will use bundled Chromium" ; fi

ENV NODE_ENV=production \
    DISPLAY=:99 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# Production deps only.
COPY package.json ./
RUN npm install --omit=dev

# Compiled app from the build stage.
COPY --from=builder /app/dist ./dist

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /data \
    && chown -R pwuser:pwuser /app /data

USER pwuser
ENV HOME=/home/pwuser
VOLUME ["/data"]
EXPOSE 8080

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/entrypoint.sh"]
# Default: run scheduler + control API together.
CMD ["all"]
