/**
 * MoniBot Telegram Bot v1.0
 * 
 * Features:
 * - /send $5 to @alice
 * - /send $1 each to @alice, @bob
 * - /balance
 * - /link - Shows linking instructions
 * - /help
 * - /giveaway $5 to the first 5
 * - Inline @monibot commands in groups
 * - Multi-chain support (Base, BSC, Tempo)
 */

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, erc20Abi, encodeFunctionData } from 'viem';
import { base, bsc } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const PORT = process.env.PORT || 3000;
const MONIBOT_PROFILE_ID = process.env.MONIBOT_PROFILE_ID || '0cb9ca32-7ef2-4ced-8389-9dbca5156c94';

// ============ Express Health ============

const app = express();
app.get('/health', (req, res) => res.json({ status: 'ok', platform: 'telegram', uptime: process.uptime() }));
app.listen(PORT, () => console.log(`🚀 Health on port ${PORT}`));

// ============ Supabase ============

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ============ Builder Code ============

const BUILDER_CODE = process.env.BUILDER_CODE || 'bc_qt9yxo1d';
function builderSuffix() {
  const bytes = Buffer.from(BUILDER_CODE, 'utf8');
  const padded = Buffer.alloc(32);
  bytes.copy(padded);
  return `8021${padded.toString('hex')}8021`;
}

// ============ Chain Configs ============

const CHAINS = {
  base: { chain: base, rpc: process.env.BASE_RPC_URL || 'https://mainnet.base.org', router: '0xBEE37c2f3Ce9a48D498FC0D47629a1E10356A516', token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, symbol: 'USDC', builder: true },
  bsc: { chain: bsc, rpc: 'https://bsc-dataseed.binance.org', router: '0x9EED16952D734dFC84b7C4e75e9A3228B42D832E', token: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, symbol: 'USDT', builder: false },
  tempo: { chain: { id: 42431, name: 'Tempo', nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.moderato.tempo.xyz'] } } }, rpc: process.env.TEMPO_RPC_URL || 'https://rpc.moderato.tempo.xyz', router: '0x78A824fDE7Ee3E69B2e2Ee52d1136EECD76749fc', token: '0x20c0000000000000000000000000000000000001', decimals: 6, symbol: 'αUSD', builder: false },
};

const routerAbi = [
  { name: 'executeP2P', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'tweetId', type: 'string' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'getNonce', type: 'function', stateMutability: 'view', inputs: [{ name: 'user', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'calculateFee', type: 'function', stateMutability: 'view', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [{ name: 'fee', type: 'uint256' }, { name: 'netAmount', type: 'uint256' }] },
];

function getClients(chain) {
  const c = CHAINS[chain];
  return {
    pub: createPublicClient({ chain: c.chain, transport: http(c.rpc, { retryCount: 3 }) }),
    wallet: createWalletClient({ account: privateKeyToAccount(process.env.MONIBOT_PRIVATE_KEY), chain: c.chain, transport: http(c.rpc, { retryCount: 3 }) }),
    config: c,
  };
}

// ============ DB Helpers ============

async function getProfileByTelegramId(telegramId) {
  const { data } = await supabase.from('profiles').select('*').eq('telegram_id', String(telegramId)).maybeSingle();
  return data;
}

async function getProfileByMonitag(tag) {
  const { data } = await supabase.from('profiles').select('*').ilike('pay_tag', tag.replace('@', '').toLowerCase()).maybeSingle();
  return data;
}

async function isProcessed(msgId) {
  const { data } = await supabase.from('platform_commands').select('id').eq('platform', 'telegram').eq('platform_message_id', String(msgId)).maybeSingle();
  return !!data;
}

async function logCmd(msg, type, amount, recipients, chain, status, profileId) {
  await supabase.from('platform_commands').upsert({
    platform: 'telegram',
    platform_message_id: String(msg.message_id),
    platform_user_id: String(msg.from.id),
    platform_channel_id: String(msg.chat.id),
    platform_server_id: msg.chat.type !== 'private' ? String(msg.chat.id) : null,
    command_type: type,
    command_text: msg.text || '',
    parsed_amount: amount,
    parsed_recipients: recipients,
    chain,
    status,
    profile_id: profileId,
  }, { onConflict: 'platform,platform_message_id' });
}

// ============ Command Parsing ============

function detectChain(text) {
  const l = text.toLowerCase();
  if (['on tempo', 'tempo', 'alphausd'].some(k => l.includes(k))) return 'tempo';
  if (['usdt', 'bnb', 'bsc'].some(k => l.includes(k))) return 'bsc';
  return 'base';
}

function parseP2P(text) {
  // Multi: "send $1 each to @a, @b"
  const multi = text.match(/(?:send|pay)\s+\$?([\d.]+)\s*(?:\w*\s+)?each\s+to\s+((?:@\w[\w-]*(?:\s*,?\s*)?)+)/i);
  if (multi) {
    const tags = (multi[2].match(/@(\w[\w-]*)/g) || []).map(m => m.slice(1).toLowerCase()).filter(t => t !== 'monibot');
    if (tags.length) return { type: 'p2p_multi', amount: parseFloat(multi[1]), recipients: tags, chain: detectChain(text) };
  }
  // Single: "send $5 to @alice"
  const single = text.match(/(?:send|pay)\s+\$?([\d.]+)\s*(?:\w*\s+)?(?:to\s+)?@(\w[\w-]*)/i);
  if (single) return { type: 'p2p', amount: parseFloat(single[1]), recipients: [single[2].toLowerCase()], chain: detectChain(text) };
  return null;
}

// ============ Telegram Bot ============

console.log('┌─────────────────────────────────────────────────┐');
console.log('│         MoniBot Telegram Bot v1.0               │');
console.log('│    Multi-Chain Payments in Groups               │');
console.log('└─────────────────────────────────────────────────┘\n');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// /start and /help
bot.onText(/\/(start|help)/, async (msg) => {
  const helpText = `🤖 *MoniBot — Instant Crypto Payments*

*Commands:*
💸 \`/send $5 to @alice\`
📤 \`/send $1 each to @alice, @bob\`
💰 \`/balance\`
🔗 \`/link\` — Connect your Telegram
🎁 \`/giveaway $5 to the first 5\`

*Networks:*
Default: USDC on Base
Add \`usdt\` for BSC, \`on tempo\` for Tempo

_Link your account at monipay.lovable.app → Settings → MoniBot AI_`;

  await bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
});

// /link
bot.onText(/\/link/, async (msg) => {
  const profile = await getProfileByTelegramId(msg.from.id);
  if (profile) {
    await bot.sendMessage(msg.chat.id, `✅ Your Telegram is linked to *@${profile.pay_tag}*`, { parse_mode: 'Markdown' });
    return;
  }
  await bot.sendMessage(msg.chat.id, `🔗 *Link Your MoniPay Account*\n\n1️⃣ Go to [monipay.lovable.app](https://monipay.lovable.app)\n2️⃣ Open *Settings* → *MoniBot AI*\n3️⃣ Click *Link Telegram*\n4️⃣ Enter your Telegram ID: \`${msg.from.id}\`\n\n_One-time setup. Then use MoniBot anywhere!_`, { parse_mode: 'Markdown', disable_web_page_preview: true });
});

// /balance
bot.onText(/\/balance/, async (msg) => {
  const profile = await getProfileByTelegramId(msg.from.id);
  if (!profile) { await bot.sendMessage(msg.chat.id, '❌ Not linked. Use /link first.'); return; }

  const chain = profile.preferred_network || 'base';
  const { pub, config } = getClients(chain);
  const bal = await pub.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [profile.wallet_address] });

  await bot.sendMessage(msg.chat.id, `💰 *${parseFloat(formatUnits(bal, config.decimals)).toFixed(2)} ${config.symbol}* on ${chain.charAt(0).toUpperCase() + chain.slice(1)}\n\n_@${profile.pay_tag}_`, { parse_mode: 'Markdown' });
});

// /send or /pay
bot.onText(/\/(send|pay)\s+(.+)/i, async (msg, match) => {
  if (await isProcessed(msg.message_id)) return;

  const text = match[2];
  const cmd = parseP2P(text);
  if (!cmd) { await bot.sendMessage(msg.chat.id, '❓ Usage: `/send $5 to @alice`', { parse_mode: 'Markdown' }); return; }

  const sender = await getProfileByTelegramId(msg.from.id);
  if (!sender) { await bot.sendMessage(msg.chat.id, '❌ Not linked. Use /link first.'); return; }

  await logCmd(msg, cmd.type, cmd.amount, cmd.recipients, cmd.chain, 'processing', sender.id);

  const results = [];
  for (const tag of cmd.recipients) {
    const recipient = await getProfileByMonitag(tag);
    if (!recipient) { results.push({ tag, ok: false, reason: 'Not found' }); continue; }
    if (recipient.id === sender.id) { results.push({ tag, ok: false, reason: 'Self-send' }); continue; }

    try {
      const { pub, wallet, config } = getClients(cmd.chain);
      const amount = parseUnits(cmd.amount.toFixed(config.decimals), config.decimals);
      const [nonce, balance, allowance] = await Promise.all([
        pub.readContract({ address: config.router, abi: routerAbi, functionName: 'getNonce', args: [sender.wallet_address] }),
        pub.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [sender.wallet_address] }),
        pub.readContract({ address: config.token, abi: erc20Abi, functionName: 'allowance', args: [sender.wallet_address, config.router] }),
      ]);

      if (balance < amount) { results.push({ tag, ok: false, reason: 'Low balance' }); continue; }
      if (allowance < amount) { results.push({ tag, ok: false, reason: 'Low allowance' }); continue; }

      let calldata = encodeFunctionData({ abi: routerAbi, functionName: 'executeP2P', args: [sender.wallet_address, recipient.wallet_address, amount, nonce, `tg_${msg.message_id}_${tag}`] });
      if (config.builder) calldata = `${calldata}${builderSuffix()}`;

      const gas = await pub.estimateContractGas({ address: config.router, abi: routerAbi, functionName: 'executeP2P', args: [sender.wallet_address, recipient.wallet_address, amount, nonce, `tg_${msg.message_id}_${tag}`], account: wallet.account?.address });
      const hash = await wallet.sendTransaction({ to: config.router, data: calldata, gas: gas + gas / 5n });
      await pub.waitForTransactionReceipt({ hash });

      const [fee] = await pub.readContract({ address: config.router, abi: routerAbi, functionName: 'calculateFee', args: [amount] });
      const feeNum = parseFloat(formatUnits(fee, config.decimals));

      await supabase.from('monibot_transactions').insert({
        sender_id: sender.id, receiver_id: recipient.id,
        amount: cmd.amount - feeNum, fee: feeNum, tx_hash: hash,
        type: 'p2p_command', payer_pay_tag: sender.pay_tag, recipient_pay_tag: recipient.pay_tag,
        chain: cmd.chain.toUpperCase(), status: 'completed', replied: true,
      });

      results.push({ tag, ok: true, hash, fee: feeNum });
    } catch (e) {
      results.push({ tag, ok: false, reason: e.message.split(':')[0] });
    }
  }

  // Build reply
  const successes = results.filter(r => r.ok);
  const failures = results.filter(r => !r.ok);
  let reply = successes.length ? `✅ *${successes.length} payment(s) sent!*\n` : '';
  successes.forEach(r => { reply += `• @${r.tag}: $${(cmd.amount - r.fee).toFixed(2)} ✓\n`; });
  if (failures.length) { reply += `\n❌ *Failed:*\n`; failures.forEach(r => { reply += `• @${r.tag}: ${r.reason}\n`; }); }

  await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'Markdown' });
});

// /giveaway
bot.onText(/\/giveaway\s+\$?([\d.]+)\s*(?:\w*\s+)?(?:to\s+)?(?:the\s+)?(?:first\s+)?(\d+)/i, async (msg, match) => {
  const amount = parseFloat(match[1]);
  const maxPeople = parseInt(match[2]);
  const chain = detectChain(msg.text);

  const sender = await getProfileByTelegramId(msg.from.id);
  if (!sender) { await bot.sendMessage(msg.chat.id, '❌ Not linked. Use /link first.'); return; }

  await bot.sendMessage(msg.chat.id, `🎁 *Giveaway by @${sender.pay_tag}!*\n\n💰 *$${amount}* each to the first *${maxPeople}* people!\n\n👇 Drop your @MoniTag below to claim!`, { parse_mode: 'Markdown' });

  let claimed = 0;
  const claimedUsers = new Set();

  // Listen for replies for 10 minutes
  const handler = async (reply) => {
    if (reply.chat.id !== msg.chat.id || claimed >= maxPeople) return;
    if (reply.from.bot || claimedUsers.has(reply.from.id)) return;

    const tagMatch = reply.text?.match(/@(\w[\w-]*)/);
    if (!tagMatch) return;
    const claimTag = tagMatch[1].toLowerCase();
    if (claimTag === 'monibot') return;

    const recipient = await getProfileByMonitag(claimTag);
    if (!recipient || recipient.id === sender.id) return;

    claimedUsers.add(reply.from.id);
    claimed++;

    try {
      const { pub, wallet, config } = getClients(chain);
      const amt = parseUnits(amount.toFixed(config.decimals), config.decimals);
      const [nonce, bal, allow] = await Promise.all([
        pub.readContract({ address: config.router, abi: routerAbi, functionName: 'getNonce', args: [sender.wallet_address] }),
        pub.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [sender.wallet_address] }),
        pub.readContract({ address: config.token, abi: erc20Abi, functionName: 'allowance', args: [sender.wallet_address, config.router] }),
      ]);

      if (bal < amt || allow < amt) {
        await bot.sendMessage(msg.chat.id, '❌ Giveaway ended — insufficient funds.');
        bot.removeListener('message', handler);
        return;
      }

      let cd = encodeFunctionData({ abi: routerAbi, functionName: 'executeP2P', args: [sender.wallet_address, recipient.wallet_address, amt, nonce, `tg_giveaway_${msg.message_id}_${claimed}`] });
      if (config.builder) cd = `${cd}${builderSuffix()}`;

      const gas = await pub.estimateContractGas({ address: config.router, abi: routerAbi, functionName: 'executeP2P', args: [sender.wallet_address, recipient.wallet_address, amt, nonce, `tg_giveaway_${msg.message_id}_${claimed}`], account: wallet.account?.address });
      const hash = await wallet.sendTransaction({ to: config.router, data: cd, gas: gas + gas / 5n });
      await pub.waitForTransactionReceipt({ hash });

      await bot.sendMessage(msg.chat.id, `✅ *$${amount}* sent to *@${recipient.pay_tag}*! (${claimed}/${maxPeople})`, { parse_mode: 'Markdown' });

      if (claimed >= maxPeople) {
        await bot.sendMessage(msg.chat.id, '🎁 *Giveaway complete!* All spots filled.', { parse_mode: 'Markdown' });
        bot.removeListener('message', handler);
      }
    } catch (e) {
      claimedUsers.delete(reply.from.id);
      claimed--;
      console.error('Giveaway error:', e.message);
    }
  };

  bot.on('message', handler);
  setTimeout(() => { bot.removeListener('message', handler); }, 600000);
});

// ============ Auto-Restart ============

setTimeout(() => { console.log('🔄 Auto-restart'); process.exit(0); }, 90 * 60 * 1000);
process.on('SIGTERM', () => { bot.stopPolling(); process.exit(0); });
process.on('SIGINT', () => { bot.stopPolling(); process.exit(0); });
