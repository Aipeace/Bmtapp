# Bybit P2P Merchant

This repository contains a multi-user Bybit P2P merchant app with:
- Express server + REST API (`server.js`)
- Telegram bot (`bot/index.js`)
- Static mini app UI (`public/index.html`)
- Simple local user store (`lib/store.js`)
- Bybit P2P API wrapper (`lib/bybit-api.js`)

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and update the values:
   ```bash
   cp .env.example .env
   ```

3. Edit `.env` with your values:
   ```env
   TELEGRAM_BOT_TOKEN=your-telegram-bot-token
   ADMIN_TELEGRAM_ID=your-admin-telegram-id
   BYBIT_API_KEY=your-bybit-api-key
   BYBIT_API_SECRET=your-bybit-api-secret
   BYBIT_TESTNET=false
   MINI_APP_URL=https://your-app-url.example.com
   ```

3. Run the web server:
   ```bash
   npm start
   ```

4. Run the Telegram bot in a separate process:
   ```bash
   npm run bot
   ```

## Render deployment

The project includes `render.yml` for:
- `bybit-p2p-server` web service
- `bybit-p2p-bot` worker service

Set the same environment variables in Render and ensure `MINI_APP_URL` points to the deployed web service.

## Notes

- User data is stored in `data/users.json`.
- The bot and web app use Telegram Web App init data for authentication.
- `bybit-pool.js` caches per-user API clients and invalidates when keys change.
