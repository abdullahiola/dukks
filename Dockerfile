FROM node:18-slim

# Install Chromium dependencies for Puppeteer (used by whatsapp-web.js)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the installed Chromium instead of downloading its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy dependency files first for better layer caching
COPY package.json package-lock.json ./

RUN npm ci --production

# Copy application code
COPY . .

# Persist WhatsApp session data so you don't have to re-scan QR after restart
VOLUME ["/app/.wwebjs_auth"]

CMD ["node", "bot.js"]
