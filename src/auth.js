// Officer authentication for the VSK Telegram bot.
//
// The ONLY way in is sharing your own phone number with Telegram's
// "Share Phone Number" button in a private chat: Telegram vouches that the
// number belongs to the sender, and it must match exactly one ACTIVE
// system_users account (by mobile, or by a username that is that mobile)
// whose role has dashboard.view. (The old
// "/register <username>" shortcut let anyone claim any account -- or a
// state-admin fallback -- and is gone.)
//
// Registrations are stored in telegram_subscribers (backend migration 100),
// so a restart no longer forgets every officer. Role and scope are re-read
// from user_roles (cached for a minute), so deactivating an account or
// changing its scope takes effect without touching the bot.

const pool = require('./db');

const CACHE_MS = 60 * 1000;
const cache = new Map(); // chatId -> { at, user }

const ACCOUNT_SQL = `
  SELECT su.id AS system_user_id, su.username, su.full_name,
         ur.role_id, r.name AS role_name, ur.scope_type, ur.scope_value
    FROM system_users su
    JOIN LATERAL (
      SELECT u.role_id, u.scope_type, u.scope_value FROM user_roles u
       WHERE u.system_user_id = su.id ORDER BY u.id LIMIT 1
    ) ur ON true
    LEFT JOIN roles r ON r.id = ur.role_id
   WHERE su.is_active = true
     AND (su.demo_expires_at IS NULL OR su.demo_expires_at > now())
     AND EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
                  WHERE rp.role_id = ur.role_id AND p.code = 'dashboard.view')`;

function shape(row) {
  if (!row) return null;
  return {
    telegramId: row.chat_id != null ? Number(row.chat_id) : undefined,
    systemUserId: Number(row.system_user_id),
    username: row.username,
    fullName: row.full_name,
    role: row.role_name || 'Officer',
    roleId: row.role_id,
    scopeType: row.scope_type || 'state',
    scopeValue: row.scope_value || null,
    language: row.language === 'en' ? 'en' : 'hi',
    briefingEnabled: row.briefing_enabled !== false,
  };
}

/** Last 10 digits -- Telegram sends "919876543210", accounts may store "+91 98765 43210". */
function last10(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

// An officer is matched by the mobile field, or by a username that IS a
// mobile number: DEO/BEO accounts migrated from the old VSK portal store
// their official contact number as the login username
// (migrations/migrate-deo-beo-users.js) and mostly leave mobile empty.
// Telegram has verified that the shared number belongs to the sender, so
// either field proves the same thing.
async function findAccountByPhone(phone) {
  const digits = last10(phone);
  if (digits.length !== 10) return { status: 'invalid' };
  const r = await pool.query(
    `${ACCOUNT_SQL}
       AND (right(regexp_replace(coalesce(su.mobile, ''), '\\D', '', 'g'), 10) = $1
            OR (su.username ~ '^[6-9][0-9]{9}$' AND su.username = $1))
     LIMIT 2`,
    [digits]
  );
  if (r.rowCount === 0) return { status: 'not_found' };
  if (r.rowCount > 1) return { status: 'ambiguous' }; // never guess between two accounts
  return { status: 'ok', account: shape(r.rows[0]) };
}

/**
 * Register a chat after a verified contact share. The caller must already
 * have checked msg.chat.type === 'private' and contact.user_id === from.id.
 */
async function registerUser({ chatId, telegramUserId, phone, telegramUsername }) {
  const found = await findAccountByPhone(phone);
  if (found.status !== 'ok') return { success: false, reason: found.status };

  await pool.query(
    `INSERT INTO telegram_subscribers (telegram_chat_id, telegram_user_id, system_user_id, telegram_username)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (telegram_chat_id) DO UPDATE
        SET telegram_user_id = EXCLUDED.telegram_user_id,
            system_user_id = EXCLUDED.system_user_id,
            telegram_username = EXCLUDED.telegram_username,
            updated_at = now()`,
    [String(chatId), String(telegramUserId), found.account.systemUserId, telegramUsername || null]
  );
  cache.delete(String(chatId));
  return { success: true, user: await getUser(chatId) };
}

/** The registered officer behind a chat, with current role/scope -- or null. */
async function getUser(chatId) {
  const key = String(chatId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.user;
  const r = await pool.query(
    `SELECT acc.*, ts.telegram_chat_id::text AS chat_id, ts.language, ts.briefing_enabled
       FROM telegram_subscribers ts
       JOIN (${ACCOUNT_SQL}) acc ON acc.system_user_id = ts.system_user_id
      WHERE ts.telegram_chat_id = $1`,
    [key]
  );
  const user = shape(r.rows[0]);
  cache.set(key, { at: Date.now(), user });
  return user;
}

async function isAuthorized(chatId) {
  return Boolean(await getUser(chatId));
}

async function setBriefing(chatId, enabled) {
  await pool.query('UPDATE telegram_subscribers SET briefing_enabled = $2, updated_at = now() WHERE telegram_chat_id = $1', [String(chatId), Boolean(enabled)]);
  cache.delete(String(chatId));
}

async function setLanguage(chatId, lang) {
  await pool.query('UPDATE telegram_subscribers SET language = $2, updated_at = now() WHERE telegram_chat_id = $1', [String(chatId), lang === 'en' ? 'en' : 'hi']);
  cache.delete(String(chatId));
}

async function unregister(chatId) {
  await pool.query('DELETE FROM telegram_subscribers WHERE telegram_chat_id = $1', [String(chatId)]);
  cache.delete(String(chatId));
}

/** Same shape as the backend's applyScope filters. Unknown scope types get nothing. */
function getScopeFilter(user) {
  if (!user || !user.scopeType || user.scopeType === 'state') return {};
  const map = {
    district: { district_cd: user.scopeValue },
    block: { block_cd: user.scopeValue },
    cluster: { cluster_cd: user.scopeValue },
    school: { udise_cd: user.scopeValue },
  };
  return map[user.scopeType] || null; // null = no access (e.g. ddo)
}

/** May this officer open the block list of `districtCd`? */
function canSeeDistrict(user, districtCd) {
  if (!user) return false;
  if (user.scopeType === 'state') return true;
  if (user.scopeType === 'district') return String(user.scopeValue) === String(districtCd);
  return false; // block/cluster/school officers see their own area via /today
}

/** State-level officers (for the optional legacy threshold alert). */
async function getStateLevelChatIds() {
  const r = await pool.query(
    `SELECT ts.telegram_chat_id::text AS chat_id
       FROM telegram_subscribers ts
       JOIN (${ACCOUNT_SQL}) acc ON acc.system_user_id = ts.system_user_id
      WHERE coalesce(acc.scope_type, 'state') = 'state'`
  );
  return r.rows.map((x) => x.chat_id);
}

module.exports = {
  registerUser,
  getUser,
  isAuthorized,
  setBriefing,
  setLanguage,
  unregister,
  getScopeFilter,
  canSeeDistrict,
  getStateLevelChatIds,
  // exported for tests
  last10,
  findAccountByPhone,
  _clearCache: () => cache.clear(),
};
