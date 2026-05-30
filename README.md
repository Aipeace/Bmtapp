# Bybit P2P Merchant

Multi-user Bybit P2P merchant app with:
- Express server + REST API (`server.js`)
- Telegram bot (`bot/index.js`)
- Static mini app UI (`public/index.html`)
- Simple local user store (`lib/store.js`)
- Bybit P2P API wrapper (`lib/bybit-api.js`)

---

## Setup (Ubuntu / Termux)

### Prerequisites

**Node.js 18+** is required (the app uses the built-in `fetch` API).

```bash
# Termux
pkg update && pkg install nodejs

# Ubuntu
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Verify: `node -v`  → should print `v18.x.x` or higher.

### Install dependencies

```bash
npm install
```

### Configure environment

```bash
cp .env.example .env
nano .env        # or: vi .env
```

Fill in **all** required values:

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From [@BotFather](https://t.me/BotFather) |
| `ADMIN_TELEGRAM_ID` | Your personal Telegram user ID |
| `APP_SECRET` | Random 32-char string (protects stored API secrets) |
| `MINI_APP_URL` | Your public URL after deploy (update after first run) |
| `BYBIT_API_KEY` / `BYBIT_API_SECRET` | Only needed for single-user `api/index.js` mode |

**Generate a secure APP_SECRET:**
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64'))"
```

### Create the data directory

The app creates `data/` automatically, but on Termux you can pre-create it:
```bash
mkdir -p data
```

---

## Running

### Option A — Server + Bot together (recommended for Termux)

```bash
npm run start:all
```

This starts both processes in the background. To stop, use `kill %1 %2` or press Ctrl+C twice.

### Option B — Two separate terminals

**Terminal 1 — Web server:**
```bash
npm start
```

**Terminal 2 — Bot:**
```bash
npm run bot
```

### Keep running after closing Termux (optional)

Install `tmux` or use `nohup`:
```bash
# With tmux (recommended)
pkg install tmux
tmux new-session -d -s server "npm start"
tmux new-session -d -s bot    "npm run bot"

# Or with nohup
nohup npm start   > server.log 2>&1 &
nohup npm run bot > bot.log    2>&1 &
```

---

## Bot commands

| Command | Description |
|---|---|
| `/start` | Register / welcome |
| `/setup` | Connect Bybit API keys |
| `/menu` | Main dashboard |
| `/mykeys` | View / remove saved keys |
| `/ads` | List your ads |
| `/orders` | List your orders |
| `/balance` | Account balance |
| `/analytics` | 30-day stats |
| `/watch` / `/unwatch` | Order push notifications |
| `/alert TOKEN CUR SIDE PRICE DIR` | Set a price alert |
| `/alerts` / `/clearalerts` | View / clear alerts |

**Admin only:** `/admin`, `/users`, `/suspend <id>`, `/reinstate <id>`, `/deluser <id>`, `/broadcast <msg>`

---

## Notes

- User data is stored in `data/users.json` (auto-created).
- API secrets are AES-256-CBC encrypted using `APP_SECRET`.
- The bot and web server are independent processes that share the same `data/users.json`.
- Both processes handle `SIGINT`/`SIGTERM` gracefully (Ctrl+C frees the port cleanly).
