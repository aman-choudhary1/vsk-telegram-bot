// Command handlers -- each takes (bot, msg) and replies.
//
// Every data command goes through guard(): the chat must belong to a
// registered, active officer, and every query is limited to that officer's
// scope (district / block / cluster / school), exactly like the dashboard.

const auth = require('./auth');
const queries = require('./queries');
const fmt = require('./formatter');
const { requestBriefing } = require('./backendClient');

const MAIN_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '🌅 Briefing', callback_data: 'cmd_briefing' },
        { text: '📊 Today', callback_data: 'cmd_today' },
      ],
      [
        { text: '📍 District-wise', callback_data: 'cmd_district' },
        { text: '🚫 Zero Schools', callback_data: 'cmd_zero' },
      ],
      [
        { text: '⚠️ Low Attendance', callback_data: 'cmd_low' },
        { text: '📖 Help', callback_data: 'cmd_help' },
      ],
    ],
  },
};

const md = (extra = {}) => ({ parse_mode: 'Markdown', ...extra });

async function guard(bot, chatId) {
  let user = null;
  try {
    user = await auth.getUser(chatId);
  } catch (err) {
    console.error('[AUTH] lookup failed:', err.message);
    await bot.sendMessage(chatId, '❌ Could not verify your account right now. Please try again shortly.');
    return null;
  }
  if (!user) {
    await bot.sendMessage(chatId, fmt.formatUnauthorized(), md());
    return null;
  }
  return user;
}

function scopeTitle(user) {
  return user.scopeType === 'state' ? 'STATE' : `${user.scopeType.toUpperCase()}`;
}

// Run a data handler; a scope the reports don't support (403) gets a clear answer.
async function withData(bot, chatId, label, fn) {
  try {
    await fn();
  } catch (err) {
    if (err.status === 403) {
      await bot.sendMessage(chatId, '🔒 Your role does not have attendance data access in this bot.');
      return;
    }
    console.error(`[${label}]`, err.message);
    await bot.sendMessage(chatId, '❌ Failed to fetch attendance data. Please try again.');
  }
}

/* ─── /start ───────────────────────────────────────────── */
async function handleStart(bot, msg) {
  const chatId = msg.chat.id;
  if (msg.chat.type !== 'private') {
    await bot.sendMessage(chatId, '🔒 For privacy, please message me in a private chat to register.');
    return;
  }
  const user = await auth.getUser(chatId).catch(() => null);
  if (user) {
    await bot.sendMessage(chatId, fmt.formatRegistered(user), md(MAIN_KEYBOARD));
    return;
  }
  await bot.sendMessage(chatId, fmt.formatWelcome(), md({
    reply_markup: {
      keyboard: [[{ text: '📞 Share Phone Number', request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  }));
}

/* ─── Contact shared: the only way to register ─────────── */
async function handleContact(bot, msg) {
  const chatId = msg.chat.id;
  const contact = msg.contact;
  if (!contact) return;

  if (msg.chat.type !== 'private') {
    await bot.sendMessage(chatId, '🔒 Please register in a private chat with the bot.');
    return;
  }
  // Telegram only vouches for the number when it is the sender's own contact.
  if (!msg.from || contact.user_id !== msg.from.id) {
    await bot.sendMessage(chatId, '⚠️ Please share *your own* phone number using the button, not someone else\'s contact.', md());
    return;
  }

  await bot.sendMessage(chatId, '🔄 Verifying your phone number…', { reply_markup: { remove_keyboard: true } });
  try {
    const result = await auth.registerUser({
      chatId,
      telegramUserId: msg.from.id,
      phone: contact.phone_number,
      telegramUsername: msg.from.username,
    });
    if (!result.success || !result.user) {
      await bot.sendMessage(chatId, fmt.formatRegisterFailure(result.reason));
      return;
    }
    console.info(JSON.stringify({ event: 'telegram.registered', chat: String(chatId), system_user_id: result.user.systemUserId }));
    await bot.sendMessage(chatId, fmt.formatRegistered(result.user), md(MAIN_KEYBOARD));
    await handleBriefing(bot, msg);
  } catch (err) {
    console.error('[AUTH] Registration error:', err.message);
    await bot.sendMessage(chatId, '❌ Something went wrong during registration. Please try /start again in a minute.');
  }
}

/* ─── /register, /login: retired (anyone could claim any account) ─ */
async function handleRegister(bot, msg) {
  await bot.sendMessage(
    msg.chat.id,
    '🔒 Registration is by phone number only. Send /start and tap *📞 Share Phone Number*.',
    md()
  );
}

/* ─── /briefing ────────────────────────────────────────── */
async function handleBriefing(bot, msg) {
  const chatId = msg.chat.id;
  const user = await guard(bot, chatId);
  if (!user) return;
  await bot.sendChatAction(chatId, 'typing').catch(() => {});
  const r = await requestBriefing(chatId);
  if (r.ok) return; // the backend sent it
  const why = {
    not_configured: 'The briefing service is not configured yet (BACKEND_URL / TELEGRAM_INTERNAL_TOKEN).',
    unreachable: 'The VSK server is not reachable right now.',
    no_access: 'Your role does not have attendance data access.',
  }[r.reason] || 'The briefing could not be prepared right now.';
  await bot.sendMessage(chatId, `⚠️ ${why}\n\nMeanwhile: /today`, MAIN_KEYBOARD);
}

/* ─── /subscribe, /unsubscribe, /language, /logout ─────── */
async function handleSubscribe(bot, msg, enabled) {
  const chatId = msg.chat.id;
  const user = await guard(bot, chatId);
  if (!user) return;
  await auth.setBriefing(chatId, enabled);
  await bot.sendMessage(chatId, enabled
    ? '🔔 Morning briefing *on*. You\'ll get it at 10:30 on working days.'
    : '🔕 Morning briefing *off*. Send /subscribe to turn it back on.', md());
}

async function handleLanguage(bot, msg) {
  const chatId = msg.chat.id;
  const user = await guard(bot, chatId);
  if (!user) return;
  const arg = (msg.text || '').replace(/^\/language(@\w+)?\s*/i, '').trim().toLowerCase();
  const lang = ['en', 'english'].includes(arg) ? 'en' : ['hi', 'hindi', 'हिंदी', 'हिन्दी'].includes(arg) ? 'hi' : null;
  if (!lang) {
    await bot.sendMessage(chatId, `🌐 Briefing language: *${user.language === 'en' ? 'English' : 'हिंदी'}*\nChange: /language en  or  /language hi`, md());
    return;
  }
  await auth.setLanguage(chatId, lang);
  await bot.sendMessage(chatId, lang === 'en' ? '🌐 Briefing language set to *English*.' : '🌐 बुलेटिन की भाषा *हिंदी* कर दी गई है।', md());
}

async function handleLogout(bot, msg) {
  await auth.unregister(msg.chat.id);
  await bot.sendMessage(msg.chat.id, '🚪 This chat is no longer linked to your VSK account. Send /start to link it again.');
}

/* ─── /today ───────────────────────────────────────────── */
async function handleToday(bot, msg) {
  const chatId = msg.chat.id;
  const user = await guard(bot, chatId);
  if (!user) return;
  await withData(bot, chatId, 'TODAY', async () => {
    const data = await queries.getStateSummary(null, auth.getScopeFilter(user));
    await bot.sendMessage(chatId, fmt.formatStateSummary(data, scopeTitle(user)), md(MAIN_KEYBOARD));
  });
}

/* ─── /district ────────────────────────────────────────── */
async function handleDistrict(bot, msg) {
  const chatId = msg.chat.id;
  const user = await guard(bot, chatId);
  if (!user) return;
  await withData(bot, chatId, 'DISTRICT', async () => {
    const data = await queries.getDistrictSummary(null, auth.getScopeFilter(user));
    const rows = [];
    // Drill-down buttons only where the officer may look.
    const drillable = data.districts.filter((d) => auth.canSeeDistrict(user, d.districtCd));
    for (let i = 0; i < drillable.length; i += 2) {
      rows.push(drillable.slice(i, i + 2).map((d) => ({ text: `📍 ${d.districtName}`, callback_data: `block_${d.districtCd}` })));
    }
    rows.push([{ text: '🔙 Summary', callback_data: 'cmd_today' }, { text: '🔄 Refresh', callback_data: 'cmd_district' }]);
    await bot.sendMessage(chatId, fmt.formatDistrictSummary(data), md({ reply_markup: { inline_keyboard: rows } }));
  });
}

/* ─── /block ───────────────────────────────────────────── */
async function handleBlock(bot, msg, districtCd) {
  const chatId = msg.chat.id;
  const user = await guard(bot, chatId);
  if (!user) return;

  await withData(bot, chatId, 'BLOCK', async () => {
    if (!districtCd) {
      if (user.scopeType === 'district') {
        districtCd = user.scopeValue; // a district officer goes straight to their own blocks
      } else if (user.scopeType === 'state') {
        const districts = await queries.getDistrictList();
        const buttons = [];
        for (let i = 0; i < districts.length; i += 2) {
          buttons.push(districts.slice(i, i + 2).map((d) => ({ text: d.district_name, callback_data: `block_${d.district_cd}` })));
        }
        await bot.sendMessage(chatId, '📍 *Select a district:*', md({ reply_markup: { inline_keyboard: buttons } }));
        return;
      } else {
        await bot.sendMessage(chatId, '📍 Block-wise view is for state and district officers. Use /today for your area.', MAIN_KEYBOARD);
        return;
      }
    }

    // Button payloads come from the client: re-check scope every time.
    if (!/^\d{1,10}$/.test(String(districtCd)) || !auth.canSeeDistrict(user, districtCd)) {
      await bot.sendMessage(chatId, '🔒 That district is outside your area.');
      return;
    }
    const data = await queries.getBlockSummary(null, districtCd);
    if (data.blocks.length === 0) {
      await bot.sendMessage(chatId, '❌ No data found for that district today.');
      return;
    }
    await bot.sendMessage(chatId, fmt.formatBlockSummary(data), md({
      reply_markup: { inline_keyboard: [[{ text: '🔙 Districts', callback_data: 'cmd_district' }, { text: '🔙 Summary', callback_data: 'cmd_today' }]] },
    }));
  });
}

/* ─── /zero ────────────────────────────────────────────── */
async function handleZero(bot, msg) {
  const chatId = msg.chat.id;
  const user = await guard(bot, chatId);
  if (!user) return;
  await withData(bot, chatId, 'ZERO', async () => {
    const date = queries.todayIST();
    const schools = await queries.getZeroAttendanceSchools(date, auth.getScopeFilter(user));
    await bot.sendMessage(chatId, fmt.formatZeroSchools(schools, date), md(MAIN_KEYBOARD));
  });
}

/* ─── /low ─────────────────────────────────────────────── */
async function handleLow(bot, msg) {
  const chatId = msg.chat.id;
  const user = await guard(bot, chatId);
  if (!user) return;
  await withData(bot, chatId, 'LOW', async () => {
    const threshold = Number(process.env.ALERT_THRESHOLD) || 75;
    const date = queries.todayIST();
    const districts = await queries.getLowAttendanceDistricts(date, threshold, auth.getScopeFilter(user));
    await bot.sendMessage(chatId, fmt.formatLowAttendance(districts, threshold, date), md(MAIN_KEYBOARD));
  });
}

/* ─── /help ────────────────────────────────────────────── */
async function handleHelp(bot, msg) {
  const user = await auth.getUser(msg.chat.id).catch(() => null);
  await bot.sendMessage(msg.chat.id, fmt.formatHelp(user), md(MAIN_KEYBOARD));
}

/* ─── Inline buttons ───────────────────────────────────── */
async function handleCallback(bot, callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const data = String(callbackQuery.data || '');
  const fakeMsg = { chat: callbackQuery.message.chat, from: callbackQuery.from };
  await bot.answerCallbackQuery(callbackQuery.id).catch(() => {});

  if (data === 'cmd_briefing') return handleBriefing(bot, fakeMsg);
  if (data === 'cmd_today') return handleToday(bot, fakeMsg);
  if (data === 'cmd_district') return handleDistrict(bot, fakeMsg);
  if (data === 'cmd_zero') return handleZero(bot, fakeMsg);
  if (data === 'cmd_low') return handleLow(bot, fakeMsg);
  if (data === 'cmd_help') return handleHelp(bot, fakeMsg);
  if (data.startsWith('block_')) return handleBlock(bot, fakeMsg, data.slice('block_'.length));
  return undefined;
}

/* ─── Plain-text shortcuts ─────────────────────────────── */
async function handleText(bot, msg) {
  const text = (msg.text || '').toLowerCase().trim();
  if (['briefing', 'bulletin', 'बुलेटिन', 'आज का हाल'].includes(text)) return handleBriefing(bot, msg);
  if (['today', 'attendance', 'summary', 'आज'].includes(text)) return handleToday(bot, msg);
  if (text === 'district' || text === 'districts') return handleDistrict(bot, msg);
  if (text === 'zero' || text === 'zero schools') return handleZero(bot, msg);
  if (text === 'low' || text === 'low attendance') return handleLow(bot, msg);
  if (text === 'help') return handleHelp(bot, msg);
  if (text.startsWith('block')) return handleBlock(bot, msg);

  if (await auth.isAuthorized(msg.chat.id).catch(() => false)) {
    await bot.sendMessage(msg.chat.id, "🤔 I didn't understand that. Try /briefing or /help.", MAIN_KEYBOARD);
  }
  return undefined;
}

module.exports = {
  handleStart,
  handleContact,
  handleRegister,
  handleBriefing,
  handleSubscribe,
  handleLanguage,
  handleLogout,
  handleToday,
  handleDistrict,
  handleBlock,
  handleZero,
  handleLow,
  handleHelp,
  handleCallback,
  handleText,
};
