require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const commands = require('./src/commands');
const alerts = require('./src/alerts');

// ─── Validate config ─────────────────────────────────────────────────
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN || TOKEN === 'YOUR_BOT_TOKEN_HERE') {
  console.error('═══════════════════════════════════════════════════════');
  console.error('  ❌ TELEGRAM_BOT_TOKEN is not set!');
  console.error('');
  console.error('  1. Open Telegram and search for @BotFather');
  console.error('  2. Send /newbot and follow the prompts');
  console.error('  3. Copy the token and paste it in .env');
  console.error('═══════════════════════════════════════════════════════');
  process.exit(1);
}

// ─── Initialize bot ───────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });

console.log('');
console.log('╔═══════════════════════════════════════════════════╗');
console.log('║   🤖 VSK Attendance Telegram Bot                 ║');
console.log('║   Vidya Samiksha Kendra • Chhattisgarh            ║');
console.log('╠═══════════════════════════════════════════════════╣');
console.log('║   Bot is running! Waiting for messages…           ║');
console.log('╚═══════════════════════════════════════════════════╝');
console.log('');

// ─── Register command handlers ────────────────────────────────────────
// Anchored so "/todayx" or text that merely contains "/low" doesn't trigger
// a command; the optional @BotName suffix is what Telegram adds in groups.
const cmd = (name) => new RegExp(`^\\/${name}(?:@\\w+)?(?:\\s|$)`, 'i');
const safe = (fn) => (msg) => Promise.resolve(fn(msg)).catch((err) => console.error('[BOT] handler failed:', err.message));

bot.onText(cmd('start'), safe((msg) => commands.handleStart(bot, msg)));
bot.onText(cmd('register'), safe((msg) => commands.handleRegister(bot, msg)));
bot.onText(cmd('login'), safe((msg) => commands.handleRegister(bot, msg)));
bot.onText(cmd('briefing'), safe((msg) => commands.handleBriefing(bot, msg)));
bot.onText(cmd('subscribe'), safe((msg) => commands.handleSubscribe(bot, msg, true)));
bot.onText(cmd('unsubscribe'), safe((msg) => commands.handleSubscribe(bot, msg, false)));
bot.onText(cmd('language'), safe((msg) => commands.handleLanguage(bot, msg)));
bot.onText(cmd('logout'), safe((msg) => commands.handleLogout(bot, msg)));
bot.onText(cmd('today'), safe((msg) => commands.handleToday(bot, msg)));
bot.onText(cmd('district'), safe((msg) => commands.handleDistrict(bot, msg)));
bot.onText(cmd('block'), safe((msg) => commands.handleBlock(bot, msg)));
bot.onText(cmd('zero'), safe((msg) => commands.handleZero(bot, msg)));
bot.onText(cmd('low'), safe((msg) => commands.handleLow(bot, msg)));
bot.onText(cmd('help'), safe((msg) => commands.handleHelp(bot, msg)));
bot.onText(cmd('refresh'), safe((msg) => commands.handleToday(bot, msg)));

// Contact shared (phone registration)
bot.on('contact', safe((msg) => commands.handleContact(bot, msg)));

// Inline button clicks
bot.on('callback_query', safe((query) => commands.handleCallback(bot, query)));

// Plain text messages (natural language shortcuts)
bot.on('message', safe((msg) => {
  // Skip if it's a command (starts with /) or a contact share
  if (msg.text && msg.text.startsWith('/')) return undefined;
  if (msg.contact) return undefined;
  return msg.text ? commands.handleText(bot, msg) : undefined;
}));

// Commands menu shown in Telegram's "/" picker.
bot.setMyCommands([
  { command: 'briefing', description: 'Morning briefing now / सुबह का बुलेटिन' },
  { command: 'today', description: 'Attendance summary for your area' },
  { command: 'district', description: 'District-wise breakdown' },
  { command: 'zero', description: 'Zero-attendance schools' },
  { command: 'subscribe', description: 'Daily briefing on' },
  { command: 'unsubscribe', description: 'Daily briefing off' },
  { command: 'language', description: 'Briefing language: en | hi' },
  { command: 'help', description: 'All commands' },
]).catch((err) => console.warn('[BOT] setMyCommands failed:', err.message));

// ─── Start scheduled alerts ───────────────────────────────────────────
alerts.start(bot);

// ─── Graceful shutdown ────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n[BOT] Shutting down…');
  alerts.stop();
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', () => {
  alerts.stop();
  bot.stopPolling();
  process.exit(0);
});
