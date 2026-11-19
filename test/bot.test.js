const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Fake DB: one officer account (district 2201) with a known mobile.
const subs = new Map();
const ACCOUNT = { system_user_id: 42, username: 'deo_koriya', full_name: 'DEO Koriya', role_id: 5, role_name: 'DEO', scope_type: 'district', scope_value: '2201' };
const dbFile = require.resolve(path.join(__dirname, '..', 'src', 'db'));
require.cache[dbFile] = {
  id: dbFile, filename: dbFile, loaded: true,
  exports: {
    query: async (sql, params = []) => {
      if (/right\(regexp_replace/.test(sql)) return params[0] === '9876543210' ? { rows: [ACCOUNT], rowCount: 1 } : { rows: [], rowCount: 0 };
      if (/INSERT INTO telegram_subscribers/.test(sql)) { subs.set(params[0], { language: 'hi', briefing_enabled: true }); return { rowCount: 1, rows: [] }; }
      if (/FROM telegram_subscribers ts/.test(sql)) {
        const s = subs.get(params[0]);
        return s ? { rows: [{ ...ACCOUNT, chat_id: params[0], ...s }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/FROM mv_school_roster r/.test(sql)) {
        return { rows: [{ district_cd: 2201, district_name: 'KORIYA', block_cd: 1, block_name: 'BAIKUNTHPUR', roster_count: 10, present_count: 8, leave_count: 1, on_duty_count: 1, school_name: 'GPS_A*B', udise_cd: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  },
};

const auth = require('../src/auth');
const commands = require('../src/commands');
const fmt = require('../src/formatter');
const queries = require('../src/queries');

function fakeBot() {
  const sent = [];
  return {
    sent,
    sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); return {}; },
    sendChatAction: async () => {},
    answerCallbackQuery: async () => {},
  };
}
const privateChat = (id) => ({ id, type: 'private' });

test('/login admin no longer grants anything', async () => {
  const bot = fakeBot();
  await commands.handleRegister(bot, { chat: privateChat(1), text: '/login admin' });
  assert.match(bot.sent[0].text, /phone number only/);
  assert.equal(await auth.getUser(1), null);
});

test('a forwarded contact or a group chat cannot register', async () => {
  const bot = fakeBot();
  await commands.handleContact(bot, { chat: privateChat(2), from: { id: 2 }, contact: { user_id: 999, phone_number: '919876543210' } });
  assert.match(bot.sent[0].text, /your own/);
  await commands.handleContact(bot, { chat: { id: -5, type: 'group' }, from: { id: 2 }, contact: { user_id: 2, phone_number: '919876543210' } });
  assert.match(bot.sent[1].text, /private chat/);
  assert.equal(subs.size, 0);
});

test('own phone matching an active account registers and is remembered', async () => {
  auth._clearCache();
  const bot = fakeBot();
  process.env.BACKEND_URL = '';
  await commands.handleContact(bot, { chat: privateChat(3), from: { id: 3, username: 'deo' }, contact: { user_id: 3, phone_number: '+91 98765 43210' } });
  assert.ok(subs.has('3'));
  assert.ok(bot.sent.some((m) => /Registered/.test(m.text)));
  const user = await auth.getUser(3);
  assert.equal(user.scopeType, 'district');
  assert.equal(user.scopeValue, '2201');
});

test('an unknown number is refused', async () => {
  const bot = fakeBot();
  await commands.handleContact(bot, { chat: privateChat(4), from: { id: 4 }, contact: { user_id: 4, phone_number: '911111111111' } });
  assert.ok(bot.sent.some((m) => /does not match an active VSK/.test(m.text)));
  assert.equal(subs.has('4'), false);
});

test('a district officer cannot open another district via a crafted button', async () => {
  const bot = fakeBot();
  await commands.handleCallback(bot, { id: 'q', data: 'block_2299', from: { id: 3 }, message: { chat: privateChat(3) } });
  assert.match(bot.sent[0].text, /outside your area/);
  const ok = fakeBot();
  await commands.handleCallback(ok, { id: 'q', data: 'block_2201', from: { id: 3 }, message: { chat: privateChat(3) } });
  assert.match(ok.sent[0].text, /BLOCK-WISE/);
});

test('scope rules', () => {
  assert.equal(auth.canSeeDistrict({ scopeType: 'state' }, '1'), true);
  assert.equal(auth.canSeeDistrict({ scopeType: 'district', scopeValue: '2201' }, '2201'), true);
  assert.equal(auth.canSeeDistrict({ scopeType: 'block', scopeValue: '9' }, '2201'), false);
  assert.equal(auth.getScopeFilter({ scopeType: 'ddo', scopeValue: 'x' }), null);
  assert.equal(auth.last10('+91 98765-43210'), '9876543210');
});

test('names are escaped so Markdown never breaks', () => {
  const BS = String.fromCharCode(92); // one backslash
  assert.equal(fmt.esc('GPS_RAIPUR *NEW* [1]'), `GPS${BS}_RAIPUR ${BS}*NEW${BS}* ${BS}[1]`);
  assert.ok(fmt.formatZeroSchools([{ name: 'GPS_A*B', district: 'X', block: 'Y', totalTeachers: 3 }], '2026-11-17').includes(`GPS${BS}_A${BS}*B`));
});

test('present includes on-duty; absent = staff - present - leave (same as the dashboard)', () => {
  const s = queries.sumRows([{ roster_count: 10, present_count: 8, leave_count: 1, on_duty_count: 1 }]);
  assert.deepEqual([s.total, s.present, s.absent, s.leave, s.pct], [10, 8, 1, 1, 80]);
});
