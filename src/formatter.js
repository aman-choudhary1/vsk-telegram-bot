// Formats attendance data into Telegram messages (legacy "Markdown" mode).
// Every name from the database goes through esc(): a school called
// "GPS_RAIPUR" or "*NEW* HS" would otherwise break Markdown parsing and
// Telegram would reject the whole message.

function esc(s) {
  return String(s ?? '').replace(/([_*`\[])/g, '\\$1');
}

function num(n) {
  return Number(n || 0).toLocaleString('en-IN');
}

function pctIcon(pct) {
  if (pct >= 90) return '🟢';
  if (pct >= 80) return '🟡';
  if (pct >= 70) return '🟠';
  return '🔴';
}

function pctBar(pct) {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return '▓'.repeat(filled) + '░'.repeat(10 - filled);
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00+05:30');
  return d.toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

function currentTime() {
  return new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
}

function formatStateSummary(data, scopeLabel = 'STATE') {
  return (
    `📊 *${esc(scopeLabel)} ATTENDANCE*\n` +
    `📅 ${formatDate(data.date)}\n` +
    `🕐 Updated: ${currentTime()}\n\n` +
    `👥 *Total Staff:* ${num(data.total)}\n` +
    `✅ *Present:* ${num(data.present)} _(incl. on duty)_\n` +
    `❌ *Absent:* ${num(data.absent)}\n` +
    `📋 *Leave:* ${num(data.leave)}\n` +
    `🏢 *On Duty:* ${num(data.onDuty)}\n` +
    `🏫 *Schools:* ${num(data.schoolCount)}\n\n` +
    `📈 *Attendance: ${data.pct}%* ${pctIcon(data.pct)}\n` +
    `${pctBar(data.pct)}`
  );
}

function formatDistrictSummary(data) {
  let msg = `📍 *DISTRICT-WISE ATTENDANCE*\n📅 ${formatDate(data.date)}\n\n`;
  for (const d of data.districts) {
    msg += `${pctIcon(d.pct)} *${esc(d.districtName)}* — ${d.pct}%\n`;
    msg += `    👥 ${num(d.total)} | ✅ ${num(d.present)} | ❌ ${num(d.absent)}\n\n`;
  }
  return msg;
}

function formatBlockSummary(data) {
  let msg = `🏛️ *BLOCK-WISE ATTENDANCE*\n📍 District: *${esc(data.districtName)}*\n📅 ${formatDate(data.date)}\n\n`;
  for (const b of data.blocks) {
    msg += `${pctIcon(b.pct)} *${esc(b.blockName)}* — ${b.pct}%\n`;
    msg += `    👥 ${num(b.total)} | ✅ ${num(b.present)} | ❌ ${num(b.absent)}\n\n`;
  }
  return msg;
}

function formatLowAttendance(districts, threshold, date) {
  if (districts.length === 0) return `✅ All districts are above ${threshold}% attendance today!`;
  let msg = `🚨 *LOW ATTENDANCE ALERT*\n📅 ${formatDate(date)}\n\nDistricts below *${threshold}%*:\n\n`;
  for (const d of districts) {
    msg += `⚠️ *${esc(d.districtName)}* — ${d.pct}%\n`;
    msg += `    👥 ${num(d.total)} | ✅ ${num(d.present)} | ❌ ${num(d.absent)}\n\n`;
  }
  msg += 'Please review the attendance dashboard.';
  return msg;
}

function formatZeroSchools(schools, date) {
  if (schools.length === 0) return '✅ No zero-attendance schools today!';
  let msg = `🚫 *ZERO ATTENDANCE SCHOOLS*\n📅 ${formatDate(date)}\nTotal: *${num(schools.length)}* schools\n\n`;
  for (const s of schools.slice(0, 30)) {
    msg += `🏫 *${esc(s.name)}*\n    📍 ${esc(s.district)} > ${esc(s.block)}\n    👥 Staff: ${s.totalTeachers}\n\n`;
  }
  if (schools.length > 30) msg += `\n_…and ${num(schools.length - 30)} more schools._`;
  return msg;
}

/* ─── Registration & help ─────────────────────────────────── */
function formatWelcome() {
  return (
    `🇮🇳 *VSK Attendance Bot*\n` +
    `_Vidya Samiksha Kendra • Chhattisgarh_\n\n` +
    `Instant attendance for your area, plus a *morning briefing* every working day at 10:30.\n\n` +
    `👉 Tap *📞 Share Phone Number* below. Your number must match your VSK dashboard account.\n\n` +
    `नीचे *📞 Share Phone Number* दबाएँ — आपका नंबर आपके VSK डैशबोर्ड खाते से मेल खाना चाहिए।`
  );
}

function formatRegistered(user) {
  const scope = user.scopeType === 'state' ? 'All State' : `${user.scopeType} ${esc(user.scopeValue)}`;
  return (
    `✅ *Registered*\n\n` +
    `👤 *${esc(user.fullName || user.username)}*\n` +
    `🏛️ ${esc(user.role)} · 📍 ${scope}\n\n` +
    `🌅 You'll receive the morning briefing at 10:30 on working days.\n` +
    `Get it now: /briefing · Language: /language en | hi · Stop: /unsubscribe`
  );
}

function formatRegisterFailure(reason) {
  if (reason === 'ambiguous') {
    return '⚠️ This phone number is linked to more than one VSK account, so I can\'t tell which one is yours. Please ask your administrator to fix the mobile number on your account.';
  }
  return '❌ This phone number does not match an active VSK dashboard account with dashboard access.\n\nPlease ask your administrator to add your mobile number to your account, then tap /start again.';
}

function formatHelp(user) {
  const who = user ? `\n👤 *${esc(user.fullName || user.username)}* (${esc(user.role)})\n📍 Scope: ${esc(user.scopeType)}\n` : '';
  return (
    `📖 *COMMANDS*${who}\n\n` +
    `🌅 /briefing — Morning briefing now (vs. normal, alerts)\n` +
    `📊 /today — Attendance summary for your area\n` +
    `📍 /district — District-wise breakdown\n` +
    `🏛️ /block — Block-wise for a district\n` +
    `🚫 /zero — Zero-attendance schools\n` +
    `⚠️ /low — Districts below threshold\n` +
    `🔔 /subscribe · 🔕 /unsubscribe — Daily briefing on/off\n` +
    `🌐 /language en | hi — Briefing language\n` +
    `🚪 /logout — Unlink this chat\n\n` +
    `_You can also type_ *today*, *district*, *zero*, *low* or *briefing*`
  );
}

function formatUnauthorized() {
  return (
    `🔒 *Access Required*\n\n` +
    `This chat isn't linked to a VSK account yet.\n` +
    `👉 Send /start and tap *📞 Share Phone Number*.`
  );
}

module.exports = {
  esc,
  formatStateSummary,
  formatDistrictSummary,
  formatBlockSummary,
  formatLowAttendance,
  formatZeroSchools,
  formatWelcome,
  formatRegistered,
  formatRegisterFailure,
  formatHelp,
  formatUnauthorized,
  formatDate,
};
