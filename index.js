/**
 * MoniBot Telegram Bot v2.0 (AI-Powered)
 * 
 * AI Features:
 * - Natural language command parsing ("yo send 5 bucks to alice")
 * - Conversational AI personality (answers questions about MoniPay)
 * - Smart intent detection with regex fallback
 * - /send, /pay, /balance, /link, /help, /giveaway
 * - Inline @monibot commands in groups
 * - Multi-chain support (Base, BSC, Tempo)
 */

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, erc20Abi, encodeFunctionData } from 'viem';
import { aiParseCommand, aiChat, aiTransactionReply } from './ai.js';
import { findAlternateChain } from './crossChainCheck.js';
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
  base: { chain: base, rpcs: [process.env.BASE_RPC_URL, 'https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://mainnet.base.org'].filter(Boolean), router: '0xBEE37c2f3Ce9a48D498FC0D47629a1E10356A516', token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, symbol: 'USDC', builder: true },
  bsc: { chain: bsc, rpcs: ['https://bsc-dataseed.binance.org', 'https://bsc-rpc.publicnode.com', 'https://bsc-dataseed1.defibit.io'], router: '0x9EED16952D734dFC84b7C4e75e9A3228B42D832E', token: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, symbol: 'USDT', builder: false },
  tempo: { chain: { id: 42431, name: 'Tempo', nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.moderato.tempo.xyz'] } } }, rpcs: [process.env.TEMPO_RPC_URL, 'https://rpc.moderato.tempo.xyz'].filter(Boolean), router: '0x78A824fDE7Ee3E69B2e2Ee52d1136EECD76749fc', token: '0x20c0000000000000000000000000000000000001', decimals: 6, symbol: 'αUSD', builder: false },
};

const rpcIndexes = { base: 0, bsc: 0, tempo: 0 };

const routerAbi = [
  { name: 'executeP2P', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'tweetId', type: 'string' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'getNonce', type: 'function', stateMutability: 'view', inputs: [{ name: 'user', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'calculateFee', type: 'function', stateMutability: 'view', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [{ name: 'fee', type: 'uint256' }, { name: 'netAmount', type: 'uint256' }] },
];

function getClients(chain) {
  const c = CHAINS[chain];
  const rpcIdx = Math.min(rpcIndexes[chain] || 0, c.rpcs.length - 1);
  const rpc = c.rpcs[rpcIdx];
  return {
    pub: createPublicClient({ chain: c.chain, transport: http(rpc, { retryCount: 3 }) }),
    wallet: createWalletClient({ account: privateKeyToAccount(process.env.MONIBOT_PRIVATE_KEY), chain: c.chain, transport: http(rpc, { retryCount: 3 }) }),
    config: c,
  };
}

function rotateRpc(chain) {
  const c = CHAINS[chain];
  if (!c) return;
  if ((rpcIndexes[chain] || 0) < c.rpcs.length - 1) {
    rpcIndexes[chain] = (rpcIndexes[chain] || 0) + 1;
    console.log(`  🔁 RPC failover [${chain}] → ${c.rpcs[rpcIndexes[chain]]}`);
  }
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

// ============ Schedule Detection via Edge Function ============

async function parseScheduleViaEdge(text) {
  try {
    const { data, error } = await supabase.functions.invoke('parse-schedule', {
      body: { text, platform: 'telegram' },
    });

    if (error) {
      console.error('[Schedule] Edge function error:', error.message);
      return parseSimpleScheduleFallback(text);
    }

    if (data?.hasSchedule && data.scheduledAt) {
      return {
        hasSchedule: true,
        scheduledAt: data.scheduledAt,
        command: data.command,
        timeDescription: data.timeDescription,
        parsed: data.parsed,
      };
    }

    return null;
  } catch (e) {
    console.error('[Schedule] Edge function exception:', e.message);
    return parseSimpleScheduleFallback(text);
  }
}

const SIMPLE_SCHEDULE = /\b(?:in\s+(\d+)\s*(s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?|h(?:(?:ou)?rs?)?|d(?:ays?)?))\s*$/i;

function parseSimpleScheduleFallback(text) {
  const match = text.match(SIMPLE_SCHEDULE);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  let ms = 0, unitLabel = '';
  if (unit.startsWith('s')) { ms = value * 1000; unitLabel = 'second'; }
  else if (unit.startsWith('m')) { ms = value * 60000; unitLabel = 'minute'; }
  else if (unit.startsWith('h')) { ms = value * 3600000; unitLabel = 'hour'; }
  else if (unit.startsWith('d')) { ms = value * 86400000; unitLabel = 'day'; }
  else return null;
  if (ms < 30000 || ms > 30 * 86400000) return null;
  const scheduledAt = new Date(Date.now() + ms);
  const commandText = text.replace(SIMPLE_SCHEDULE, '').trim();
  const plural = value !== 1 ? 's' : '';
  return {
    hasSchedule: true,
    scheduledAt: scheduledAt.toISOString(),
    command: commandText.replace(/^\/(?:send|pay|monibot)\s*/i, '').replace(/^monibot\s*/i, '').trim(),
    timeDescription: `in ${value} ${unitLabel}${plural}`,
  };
}

// ============ Command Parsing ============

function detectChain(text) {
  const l = text.toLowerCase();
  if (['on tempo', 'tempo', 'alphausd'].some(k => l.includes(k))) return 'tempo';
  if (['usdt', 'bnb', 'bsc'].some(k => l.includes(k))) return 'bsc';
  return 'base';
}

function parseP2P(text) {
  // Multi: "send $1 each to @a, @b" or "send $1 each to @a and @b"
  const multi = text.match(/(?:send|pay)\s+\$?([\d.]+)\s*(?:\w*\s+)?each\s+to\s+(.*)/i);
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
console.log('│       MoniBot Telegram Bot v2.0 (AI-Powered)    │');
console.log('│    NLP Commands + Conversational AI              │');
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

    let activeChain = cmd.chain;
    const result = await attemptP2POnChain(msg, sender, recipient, cmd.amount, tag, activeChain);
    
    if (result.ok) {
      results.push(result);
      continue;
    }
    
    // Cross-chain fallback
    if (result.reason === 'Low balance' || result.reason === 'Low allowance') {
      const alt = await findAlternateChain(sender.wallet_address, cmd.amount, activeChain);
      
      if (alt && !alt.needsAllowance) {
        await bot.sendMessage(msg.chat.id, `🔄 Rerouting to *${alt.chain.toUpperCase()}* (${alt.balance.toFixed(2)} ${alt.symbol})...`, { parse_mode: 'Markdown' });
        const retryResult = await attemptP2POnChain(msg, sender, recipient, cmd.amount, tag, alt.chain);
        if (retryResult.ok) retryResult.rerouted = `${activeChain} → ${alt.chain}`;
        results.push(retryResult);
        continue;
      } else if (alt && alt.needsAllowance) {
        results.push({ tag, ok: false, reason: `Funds on ${alt.chain.toUpperCase()} but needs allowance` });
        continue;
      }
    }
    
    results.push(result);
  }

  // Build reply
  const successes = results.filter(r => r.ok);
  const failures = results.filter(r => !r.ok);
  let reply = successes.length ? `✅ *${successes.length} payment(s) sent!*\n` : '';
  successes.forEach(r => {
    const routeNote = r.rerouted ? ` _(${r.rerouted})_` : '';
    reply += `• @${r.tag}: $${(cmd.amount - r.fee).toFixed(2)} ✓${routeNote}\n`;
  });
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
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status === 'reverted') {
        claimedUsers.delete(reply.from.id);
        claimed--;
        await bot.sendMessage(msg.chat.id, `Transaction for @${recipient.pay_tag} was reverted on-chain.`);
        return;
      }

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

// ============ AI-Powered Natural Language Handler ============
// Catches messages that mention @monibot or reply to bot but don't match slash commands

bot.on('message', async (msg) => {
  if (!msg.text) return;
  const text = msg.text.trim();
  
  // Skip slash commands (handled above) and bot's own messages
  if (text.startsWith('/')) return;
  if (msg.from?.is_bot) return;
  
  // Only respond if mentioned or in private chat or replying to bot
  const isMentioned = text.toLowerCase().includes('@monibot') || text.toLowerCase().includes('monibot');
  const isPrivate = msg.chat.type === 'private';
  const isReplyToBot = msg.reply_to_message?.from?.id === bot.options?.polling?.params?.id;
  
  if (!isMentioned && !isPrivate && !isReplyToBot) return;
  
  // Clean the text
  const cleaned = text.replace(/@monibot/gi, '').replace(/monibot/gi, '').trim();
  if (!cleaned) return;
  
  // Deduplication
  if (await isProcessed(msg.message_id)) return;
  
  console.log(`[AI] NLP input from ${msg.from.username || msg.from.id}: "${cleaned.substring(0, 80)}"`);
  
  // Check for time-aware scheduling via edge function
  const scheduleResult = await parseScheduleViaEdge(text);
  if (scheduleResult?.hasSchedule && scheduleResult.scheduledAt && scheduleResult.command) {
    await handleScheduledCommandTg(msg, scheduleResult, cleaned);
    return;
  }
  
  // Try regex first (fast path)
  const regexCmd = parseP2P(cleaned);
  if (regexCmd) {
    await executeP2PCommand(msg, regexCmd);
    return;
  }
  
  // Try AI parsing
  const aiResult = await aiParseCommand(cleaned, 'telegram');
  
  if (aiResult && aiResult.type && aiResult.type !== 'chat') {
    if (aiResult.type === 'balance') {
      const profile = await getProfileByTelegramId(msg.from.id);
      if (!profile) { await bot.sendMessage(msg.chat.id, '❌ Not linked. Use /link first.'); return; }
      const chain = aiResult.chain || profile.preferred_network || 'base';
      const { pub, config } = getClients(chain);
      const bal = await pub.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [profile.wallet_address] });
      await bot.sendMessage(msg.chat.id, `💰 *${parseFloat(formatUnits(bal, config.decimals)).toFixed(2)} ${config.symbol}* on ${chain.charAt(0).toUpperCase() + chain.slice(1)}`, { parse_mode: 'Markdown' });
      return;
    }
    
    if (aiResult.type === 'help') {
      bot.emit('text', msg);
      return;
    }
    
    if (aiResult.type === 'link') {
      const profile = await getProfileByTelegramId(msg.from.id);
      if (profile) {
        await bot.sendMessage(msg.chat.id, `✅ Already linked to *@${profile.pay_tag}*`, { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(msg.chat.id, `🔗 Link at [monipay.lovable.app](https://monipay.lovable.app) → Settings → MoniBot AI → Link Telegram`, { parse_mode: 'Markdown', disable_web_page_preview: true });
      }
      return;
    }
    
    // AI-parsed giveaway
    if (aiResult.type === 'giveaway' && aiResult.amount && aiResult.maxParticipants) {
      await handleGiveawayTg(msg, aiResult.amount, aiResult.maxParticipants, aiResult.chain || 'base');
      return;
    }
    
    if ((aiResult.type === 'p2p' || aiResult.type === 'p2p_multi') && aiResult.amount && aiResult.recipients?.length) {
      await executeP2PCommand(msg, { type: aiResult.type, amount: aiResult.amount, recipients: aiResult.recipients, chain: aiResult.chain || 'base' });
      return;
    }
  }
  
  // Conversational AI fallback
  const chatReply = await aiChat(cleaned, msg.from.username || msg.from.first_name, 'telegram');
  if (chatReply) {
    await bot.sendMessage(msg.chat.id, chatReply, { parse_mode: 'Markdown' });
  } else {
    await bot.sendMessage(msg.chat.id, "I'm MoniBot! 💸 Try `/help` to see what I can do.", { parse_mode: 'Markdown' });
  }
});

// ============ Shared P2P Execution ============

async function executeP2PCommand(msg, cmd) {
  const sender = await getProfileByTelegramId(msg.from.id);
  if (!sender) { await bot.sendMessage(msg.chat.id, '❌ Not linked. Use /link first.'); return; }
  
  await logCmd(msg, cmd.type, cmd.amount, cmd.recipients, cmd.chain, 'processing', sender.id);
  
  const results = [];
  for (const tag of cmd.recipients) {
    const recipient = await getProfileByMonitag(tag);
    if (!recipient) { results.push({ tag, ok: false, reason: 'Not found' }); continue; }
    if (recipient.id === sender.id) { results.push({ tag, ok: false, reason: 'Self-send' }); continue; }
    
    let activeChain = cmd.chain;
    const result = await attemptP2POnChain(msg, sender, recipient, cmd.amount, tag, activeChain);
    
    if (result.ok) {
      results.push(result);
      continue;
    }
    
    // Cross-chain fallback on balance/allowance errors
    if (result.reason === 'Low balance' || result.reason === 'Low allowance') {
      const alt = await findAlternateChain(sender.wallet_address, cmd.amount, activeChain);
      
      if (alt && !alt.needsAllowance) {
        await bot.sendMessage(msg.chat.id, `🔄 Rerouting @${tag} payment to *${alt.chain.toUpperCase()}* (${alt.balance.toFixed(2)} ${alt.symbol})...`, { parse_mode: 'Markdown' });
        const retryResult = await attemptP2POnChain(msg, sender, recipient, cmd.amount, tag, alt.chain);
        if (retryResult.ok) retryResult.rerouted = `${activeChain} → ${alt.chain}`;
        results.push(retryResult);
        continue;
      } else if (alt && alt.needsAllowance) {
        results.push({ tag, ok: false, reason: `Funds on ${alt.chain.toUpperCase()} but needs allowance` });
        continue;
      }
    }
    
    results.push(result);
  }
  
  // Build AI-powered natural language reply
  if (results.length === 1 && results[0].ok) {
    const r = results[0];
    const aiReply = await aiTransactionReply({
      type: r.rerouted ? 'p2p_rerouted' : 'p2p_success',
      amount: cmd.amount - r.fee,
      fee: r.fee,
      symbol: CHAINS[r.rerouted ? r.rerouted.split(' → ')[1] : cmd.chain]?.symbol || 'USDC',
      recipient: r.tag,
      sender: sender.pay_tag,
      chain: r.rerouted ? r.rerouted.split(' → ')[1] : cmd.chain,
      originalChain: r.rerouted ? r.rerouted.split(' → ')[0] : undefined,
      txHash: r.hash,
    });
    await bot.sendMessage(msg.chat.id, aiReply || `Sent $${(cmd.amount - r.fee).toFixed(2)} to @${r.tag}. TX: \`${r.hash.substring(0, 18)}...\``, { parse_mode: 'Markdown' });
    return;
  }

  if (results.length === 1 && !results[0].ok) {
    const r = results[0];
    let failType = 'error_generic';
    if (r.reason === 'Low balance') failType = 'error_balance';
    else if (r.reason === 'Low allowance') failType = 'error_allowance';
    else if (r.reason?.includes('reverted')) failType = 'error_reverted';
    else if (r.reason === 'Not found') failType = 'error_not_found';
    
    const aiReply = await aiTransactionReply({ type: failType, sender: sender.pay_tag, recipient: r.tag, amount: cmd.amount, chain: cmd.chain });
    const fallbacks = {
      error_balance: `Your balance is too low to send $${cmd.amount}. Fund your wallet at monipay.lovable.app`,
      error_allowance: `You need to set your MoniBot allowance first. Go to monipay.lovable.app → Settings → MoniBot AI`,
      error_reverted: `The transaction was submitted but reverted on-chain. Please try again.`,
      error_not_found: `@${r.tag} isn't registered on MoniPay yet. They can sign up at monipay.lovable.app`,
      error_generic: `Something went wrong sending to @${r.tag}. Please try again.`,
    };
    await bot.sendMessage(msg.chat.id, aiReply || fallbacks[failType], { parse_mode: 'Markdown' });
    return;
  }

  // Multi-recipient summary
  const successes = results.filter(r => r.ok);
  const failures = results.filter(r => !r.ok);
  let reply = successes.length ? `✅ *${successes.length} payment(s) sent!*\n` : '';
  successes.forEach(r => {
    const routeNote = r.rerouted ? ` _(routed: ${r.rerouted})_` : '';
    reply += `• @${r.tag}: $${(cmd.amount - r.fee).toFixed(2)} ✓${routeNote}\n`;
  });
  if (failures.length) { reply += `\n❌ *Failed:*\n`; failures.forEach(r => { reply += `• @${r.tag}: ${r.reason}\n`; }); }
  
  await bot.sendMessage(msg.chat.id, reply, { parse_mode: 'Markdown' });
}

/**
 * Attempt a single P2P transfer on a specific chain. Returns result object.
 */
async function attemptP2POnChain(msg, sender, recipient, amount, tag, chainName) {
  try {
    const { pub, wallet, config } = getClients(chainName);
    const amountUnits = parseUnits(amount.toFixed(config.decimals), config.decimals);
    const [nonce, balance, allowance] = await Promise.all([
      pub.readContract({ address: config.router, abi: routerAbi, functionName: 'getNonce', args: [sender.wallet_address] }),
      pub.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [sender.wallet_address] }),
      pub.readContract({ address: config.token, abi: erc20Abi, functionName: 'allowance', args: [sender.wallet_address, config.router] }),
    ]);
    
    if (balance < amountUnits) return { tag, ok: false, reason: 'Low balance' };
    if (allowance < amountUnits) return { tag, ok: false, reason: 'Low allowance' };
    
    let calldata = encodeFunctionData({ abi: routerAbi, functionName: 'executeP2P', args: [sender.wallet_address, recipient.wallet_address, amountUnits, nonce, `tg_${msg.message_id}_${tag}`] });
    if (config.builder) calldata = `${calldata}${builderSuffix()}`;
    
    const gas = await pub.estimateContractGas({ address: config.router, abi: routerAbi, functionName: 'executeP2P', args: [sender.wallet_address, recipient.wallet_address, amountUnits, nonce, `tg_${msg.message_id}_${tag}`], account: wallet.account?.address });
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status === 'reverted') return { tag, ok: false, reason: 'Transaction reverted on-chain' };
    
    const [fee] = await pub.readContract({ address: config.router, abi: routerAbi, functionName: 'calculateFee', args: [amountUnits] });
    const feeNum = parseFloat(formatUnits(fee, config.decimals));
    
    await supabase.from('monibot_transactions').insert({
      sender_id: sender.id, receiver_id: recipient.id,
      amount: amount - feeNum, fee: feeNum, tx_hash: hash,
      type: 'p2p_command', payer_pay_tag: sender.pay_tag, recipient_pay_tag: recipient.pay_tag,
      chain: chainName.toUpperCase(), status: 'completed', replied: true,
    });
    
    return { tag, ok: true, hash, fee: feeNum };
  } catch (e) {
    return { tag, ok: false, reason: e.message.split(':')[0] };
  }
}

// ============ AI-Parsed Giveaway for Telegram ============

async function handleGiveawayTg(msg, amount, maxPeople, chain) {
  const sender = await getProfileByTelegramId(msg.from.id);
  if (!sender) { await bot.sendMessage(msg.chat.id, '❌ Not linked. Use /link first.'); return; }

  await bot.sendMessage(msg.chat.id, `🎁 *Giveaway by @${sender.pay_tag}!*\n\n💰 *$${amount}* each to the first *${maxPeople}* people!\n\n👇 Drop your @MoniTag below to claim!`, { parse_mode: 'Markdown' });

  let claimed = 0;
  const claimedUsers = new Set();

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
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status === 'reverted') {
        claimedUsers.delete(reply.from.id);
        claimed--;
        await bot.sendMessage(msg.chat.id, `Transaction for @${recipient.pay_tag} was reverted. Skipping.`);
        return;
      }
      await supabase.from('monibot_transactions').insert({
        sender_id: sender.id, receiver_id: recipient.id,
        amount: amount, fee: 0, tx_hash: hash,
        type: 'p2p_command', payer_pay_tag: sender.pay_tag, recipient_pay_tag: recipient.pay_tag,
        chain: chain.toUpperCase(), status: 'completed', replied: true,
      });

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
}

// ============ Scheduled Command Handler ============

async function handleScheduledCommandTg(msg, scheduleResult, originalText) {
  const sender = await getProfileByTelegramId(msg.from.id);
  if (!sender) { await bot.sendMessage(msg.chat.id, '❌ Not linked. Use /link first.'); return; }

  const scheduledAt = new Date(scheduleResult.scheduledAt);
  if (scheduledAt <= new Date()) {
    await bot.sendMessage(msg.chat.id, '⏰ That time is in the past. Please specify a future time.');
    return;
  }

  // Parse the underlying command
  const innerCmd = parseP2P(scheduleResult.command);
  let aiCmd = null;
  if (!innerCmd) {
    const aiResult = await aiParseCommand(scheduleResult.command, 'telegram');
    if (aiResult && aiResult.type && aiResult.type !== 'chat' && aiResult.type !== 'help' && aiResult.type !== 'link' && aiResult.type !== 'balance') {
      aiCmd = aiResult;
    }
  }

  const cmd = innerCmd || aiCmd;
  if (!cmd) {
    await bot.sendMessage(msg.chat.id, '❌ I can only schedule payment commands. Try: `monibot send $5 to @alice tomorrow at 3pm`', { parse_mode: 'Markdown' });
    return;
  }

  const { data: job, error } = await supabase.from('scheduled_jobs').insert({
    type: cmd.type === 'giveaway' ? 'scheduled_giveaway' : 'scheduled_p2p',
    scheduled_at: scheduledAt.toISOString(),
    payload: {
      platform: 'telegram',
      chatId: msg.chat.id,
      senderId: sender.id,
      senderPayTag: sender.pay_tag,
      senderWallet: sender.wallet_address,
      command: cmd,
      originalText,
    },
    status: 'pending',
    source_author_id: String(msg.from.id),
    source_author_username: msg.from.username || msg.from.first_name,
    source_tweet_id: String(msg.message_id),
  }).select().maybeSingle();

  if (error) console.error('❌ Failed to schedule:', error.message);

  const timeDesc = scheduleResult.timeDescription || scheduledAt.toUTCString();
  const ts = Math.floor(scheduledAt.getTime() / 1000);

  await bot.sendMessage(msg.chat.id, 
    `⏰ *Command Scheduled!*\n\n📋 *Command:* ${scheduleResult.command}\n🕐 *When:* ${timeDesc}\n✅ *Status:* ${job ? 'Queued' : 'Failed to queue'}\n\n_Job ID: ${job?.id || 'N/A'}_`,
    { parse_mode: 'Markdown' }
  );
}

// ============ Auto-Restart ============

setTimeout(() => { console.log('🔄 Auto-restart'); process.exit(0); }, 90 * 60 * 1000);
process.on('SIGTERM', () => { bot.stopPolling(); process.exit(0); });
process.on('SIGINT', () => { bot.stopPolling(); process.exit(0); });
