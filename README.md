# MoniBot Telegram Bot

Multi-chain payment bot for Telegram groups. Supports Base (USDC), BSC (USDT), and Tempo (αUSD).

## Setup

### 1. Create Telegram Bot
1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the **Bot Token**

### 2. Environment Variables
Copy `.env.example` to `.env` and fill in:
```bash
TELEGRAM_BOT_TOKEN=your-bot-token
SUPABASE_URL=https://vdaeojxonqmzejwiioaq.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
MONIBOT_PRIVATE_KEY=your-executor-private-key
BASE_RPC_URL=https://mainnet.base.org
```

### 3. Deploy to Railway
```bash
railway init
railway up
```

## Commands

| Command | Description |
|---------|-------------|
| `/send $5 to @alice` | Send payment |
| `/send $1 each to @alice, @bob` | Multi-send |
| `/giveaway $5 to the first 10` | Start giveaway |
| `/balance` | Check balance |
| `/link` | Link instructions |
| `/help` | Show all commands |

### Network Selection
- Default: USDC on Base
- Add `usdt` for BSC
- Add `on tempo` for Tempo

## Architecture
- **node-telegram-bot-api** with polling
- **viem** for blockchain interactions
- **Supabase** for profile lookup and transaction logging
- **90-minute auto-restart** for token refresh
