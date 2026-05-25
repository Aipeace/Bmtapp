# Bybit P2P Merchant — Telegram Bot + Mini App

Complete P2P merchant tooling: a Telegram Bot for quick actions + a full Mini App dashboard, both talking to Bybit’s REST API v5.

-----

## Project Structure

```
/
├── api/
│   └── index.js          ← Vercel serverless function (all /api/* routes)
├── public/
│   └── index.html        ← Telegram Mini App (served at /)
├── lib/
│   └── bybit-api.js      ← Bybit P2P REST API v5 client
├── bot/
│   └── index.js          ← Telegram Bot (run separately, NOT on Vercel)
├── vercel.json           ← Routing config
├── package.json
├── .env.example
└── .gitignore
```

-----

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/Aipeace/JsBybitP2pM
cd JsBybitP2pM
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Open .env and fill in your keys
```

### 3. Get your keys

**Telegram Bot Token** — from [@BotFather](https://t.me/BotFather):

```
/newbot
→ follow the prompts
→ copy the token
```

**Bybit API Keys** — from [bybit.com](https://bybit.com):

```
Account → API Management → Create New Key
Permissions: Read + Trade
Scopes: P2P Trading
IP whitelist: add your server IP (or leave open for testing)
```

### 4. Deploy to Vercel

```bash
npx vercel --prod
```

Or connect the GitHub repo in the Vercel dashboard:

|Field           |Value          |
|----------------|---------------|
|Framework Preset|`Other`        |
|Root Directory  |*(leave blank)*|
|Build Command   |*(leave blank)*|
|Output Directory|`public`       |
|Install Command |`npm install`  |

**Environment Variables** to add in Vercel dashboard:

|Key                 |Value                               |
|--------------------|------------------------------------|
|`BYBIT_API_KEY`     |your key                            |
|`BYBIT_API_SECRET`  |your secret                         |
|`BYBIT_TESTNET`     |`false`                             |
|`TELEGRAM_BOT_TOKEN`|your token                          |
|`MINI_APP_URL`      |your Vercel URL (after first deploy)|

### 5. Register the Mini App with BotFather

```
/newapp
→ select your bot
→ enter Mini App URL = https://your-project.vercel.app
```

### 6. Run the Bot (on Railway / Render / VPS)

The Telegram bot uses long-polling and cannot run on Vercel (serverless). Run it on a persistent host:

```bash
# Local
node bot/index.js

# Railway: set env vars in dashboard, deploy via GitHub
# Render: create a Web Service pointing to bot/index.js
```

-----

## API Endpoints

All served at `/api/*` by Vercel.

### Account

|Method|Path                  |Description              |
|------|----------------------|-------------------------|
|GET   |`/api/health`         |Health check             |
|GET   |`/api/balance`        |FUND wallet balance      |
|GET   |`/api/profile`        |P2P merchant profile     |
|GET   |`/api/payment-methods`|Saved payment methods    |
|GET   |`/api/tokens`         |Supported tokens         |
|GET   |`/api/currencies`     |Supported fiat currencies|

### Ads

|Method|Path                 |Description          |
|------|---------------------|---------------------|
|GET   |`/api/ads`           |List your ads        |
|POST  |`/api/ads`           |Create ad            |
|GET   |`/api/ads/:id`       |Ad detail            |
|PUT   |`/api/ads/:id`       |Update ad            |
|PATCH |`/api/ads/:id/status`|Toggle online/offline|
|DELETE|`/api/ads/:id`       |Delete ad            |

### Orders

|Method|Path                     |Description                      |
|------|-------------------------|---------------------------------|
|GET   |`/api/orders`            |List orders (optional `?status=`)|
|GET   |`/api/orders/history`    |History (`?days=30`)             |
|GET   |`/api/orders/:id`        |Order detail                     |
|POST  |`/api/orders/:id/pay`    |Confirm payment                  |
|POST  |`/api/orders/:id/release`|Release crypto                   |
|POST  |`/api/orders/:id/cancel` |Cancel order                     |
|POST  |`/api/orders/:id/appeal` |Open appeal                      |

### Chat

|Method|Path                      |Description        |
|------|--------------------------|-------------------|
|GET   |`/api/orders/:id/messages`|Fetch chat messages|
|POST  |`/api/orders/:id/messages`|Send message       |

### Market

|Method|Path             |Description        |
|------|-----------------|-------------------|
|GET   |`/api/market/ads`|Live P2P market ads|

-----

## Bot Commands

|Command                                     |Description                           |
|--------------------------------------------|--------------------------------------|
|`/start`                                    |Dashboard + subscribe to notifications|
|`/menu`                                     |Main menu                             |
|`/ads`                                      |List your ads                         |
|`/orders`                                   |List orders                           |
|`/balance`                                  |Account balance                       |
|`/analytics`                                |30-day stats                          |
|`/watch`                                    |Subscribe to push notifications       |
|`/alert TOKEN CURRENCY SIDE PRICE DIRECTION`|Set a price alert                     |
|`/alerts`                                   |View active alerts                    |
|`/clearalerts`                              |Remove all alerts                     |
|`/help`                                     |Command reference                     |

**Price alert example:**

```
/alert USDT NGN SELL 1600 ABOVE
```

Fires when the best SELL USDT/NGN ad goes above 1600.

-----

## Mini App Tabs

|Tab     |What it does                                      |
|--------|--------------------------------------------------|
|🏠 Home  |Live stats, market snapshot, recent orders        |
|📋 Ads   |Full CRUD: create, edit, toggle, delete           |
|📦 Orders|Filter by status, one-tap pay / release / cancel  |
|💬 Chat  |Per-order chat with 5-second auto-poll            |
|📊 Stats |Volume chart, completion rate, price alert manager|

-----

## Production Notes

- **Bot polling → webhook**: swap `{ polling: true }` for `bot.setWebHook(url)` + Express endpoint when deploying at scale.
- **Sessions**: replace the in-memory `Map` with Redis for multi-process setups.
- **Telegram init data validation**: uncomment the `validateTgData` block in `api/index.js` before going live.
- **Bybit IP whitelist**: add your Vercel edge IP ranges or leave open only during development.
- **HTTPS**: Telegram requires HTTPS for Mini Apps. Vercel provides this automatically.