// Legacy "districts below X%" alert.
//
// Replaced by the backend's morning briefing (vsk_attendance_backend
// services/telegramBriefing.js), which compares each area with its own
// normal instead of one fixed threshold and goes to every subscribed officer
// for their own scope. Running both would send two messages every morning, so
// this one is OFF unless ALERT_LEGACY=on.

const cron = require('node-cron');
const queries = require('./queries');
const auth = require('./auth');
const fmt = require('./formatter');

let cronJob = null;

function start(bot) {
  if (process.env.ALERT_LEGACY !== 'on') {
    console.log('[ALERTS] Legacy threshold alert off (the backend sends the morning briefing). Set ALERT_LEGACY=on to enable.');
    return;
  }
  const cronExpr = process.env.ALERT_CRON || '30 10 * * 1-6';
  const threshold = Number(process.env.ALERT_THRESHOLD) || 75;
  console.log(`[ALERTS] Legacy low-attendance check: "${cronExpr}" (threshold: ${threshold}%)`);

  cronJob = cron.schedule(cronExpr, async () => {
    try {
      const date = queries.todayIST();
      const lowDistricts = await queries.getLowAttendanceDistricts(date, threshold);
      if (lowDistricts.length === 0) return;
      const message = fmt.formatLowAttendance(lowDistricts, threshold, date);

      const envIds = (process.env.ALERT_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
      const allIds = [...new Set([...(await auth.getStateLevelChatIds()), ...envIds])];
      for (const chatId of allIds) {
        try {
          await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (err) {
          console.error(`[ALERTS] Failed to send to ${chatId}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[ALERTS] Scheduled check failed:', err.message);
    }
  }, { timezone: 'Asia/Kolkata' });
}

function stop() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }
}

module.exports = { start, stop };
