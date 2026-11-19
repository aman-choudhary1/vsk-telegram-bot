// Asks the VSK backend to build and send one chat's morning briefing now.
// The backend owns briefing content (anomaly radar, holidays, scope rules);
// see vsk_attendance_backend/src/routes/telegramInternal.routes.js.
//
// Needs BACKEND_URL (e.g. http://localhost:5000) and TELEGRAM_INTERNAL_TOKEN
// (the same long random value in both .env files).

async function requestBriefing(chatId, { fetchImpl = fetch, env = process.env } = {}) {
  const base = (env.BACKEND_URL || '').replace(/\/+$/, '');
  const token = env.TELEGRAM_INTERNAL_TOKEN;
  if (!base || !token) return { ok: false, reason: 'not_configured' };
  try {
    const res = await fetchImpl(`${base}/api/internal/telegram/briefing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
      body: JSON.stringify({ chat_id: String(chatId) }),
      signal: AbortSignal.timeout(30000),
    });
    let body = {};
    try { body = await res.json(); } catch { body = {}; }
    return { ok: res.ok && body.ok !== false, reason: body.reason || (res.ok ? null : `http_${res.status}`) };
  } catch (err) {
    return { ok: false, reason: 'unreachable', detail: err.message };
  }
}

module.exports = { requestBriefing };
