// Attendance queries for the bot. Same sources and rules as the dashboard
// (backend services/schoolAttendanceQueries.js):
//   - mv_school_roster + school_daily_attendance_rollup (precomputed, fast);
//     the old mv_school_daily_attendance no longer exists, and the live view
//     this used to fall back to took 8-10 s per call;
//   - "present" includes approved on-duty, "absent" = staff - present - leave;
//   - schools in a district that has a holiday that day are left out.

const pool = require('./db');

function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

const SCOPE_COLUMNS = { district_cd: 'r.district_cd', block_cd: 'r.block_cd', cluster_cd: 'r.cluster_cd', udise_cd: 'r.udise_cd' };

function buildWhere(scopeFilter, startIdx) {
  const clauses = [];
  const params = [];
  let idx = startIdx;
  for (const [key, col] of Object.entries(SCOPE_COLUMNS)) {
    if (scopeFilter && scopeFilter[key] != null && scopeFilter[key] !== '') {
      clauses.push(`${col}::text = $${idx}`);
      params.push(String(scopeFilter[key]));
      idx++;
    }
  }
  return { clauses, params };
}

async function querySchoolRows(date, scopeFilter = {}) {
  if (scopeFilter === null) {
    const err = new Error('no access for this scope');
    err.status = 403;
    throw err;
  }
  const where = buildWhere(scopeFilter, 2);
  const extra = where.clauses.length ? ` AND ${where.clauses.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT r.udise_cd, r.school_name, r.district_cd, r.district_name,
            r.block_cd, r.block_name, r.cluster_cd, r.cluster_name,
            r.roster_count::int AS roster_count,
            (COALESCE(d.present_count, 0) + COALESCE(d.on_duty_count, 0))::int AS present_count,
            COALESCE(d.leave_count, 0)::int AS leave_count,
            COALESCE(d.on_duty_count, 0)::int AS on_duty_count
       FROM mv_school_roster r
       LEFT JOIN school_daily_attendance_rollup d ON d.udise_cd = r.udise_cd AND d.event_date = $1
      WHERE r.roster_count > 0
        AND NOT EXISTS (SELECT 1 FROM attendance_holidays ah
                         WHERE ah.holiday_date = $1::date
                           AND (ah.scope = 'state' OR (ah.scope = 'district' AND ah.district_cd = r.district_cd)))${extra}
      ORDER BY r.district_name, r.block_name, r.school_name`,
    [date, ...where.params]
  );
  return result.rows;
}

function sumRows(rows) {
  let total = 0, present = 0, leave = 0, onDuty = 0;
  for (const r of rows) {
    total += r.roster_count;
    present += r.present_count; // includes on duty
    leave += r.leave_count;
    onDuty += r.on_duty_count;
  }
  const absent = Math.max(total - present - leave, 0);
  const pct = total > 0 ? Math.round((present / total) * 1000) / 10 : 0;
  return { total, present, absent, leave, onDuty, pct, schoolCount: rows.length };
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const key = keyFn(r);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

async function getStateSummary(date, scopeFilter = {}) {
  date = date || todayIST();
  const rows = await querySchoolRows(date, scopeFilter);
  return { date, ...sumRows(rows) };
}

async function getDistrictSummary(date, scopeFilter = {}) {
  date = date || todayIST();
  const rows = await querySchoolRows(date, scopeFilter);
  const districts = [];
  for (const [cd, distRows] of groupBy(rows, (r) => r.district_cd)) {
    districts.push({ districtCd: String(cd), districtName: distRows[0].district_name, ...sumRows(distRows) });
  }
  districts.sort((a, b) => b.pct - a.pct);
  return { date, districts };
}

async function getBlockSummary(date, districtCd) {
  date = date || todayIST();
  const rows = await querySchoolRows(date, { district_cd: districtCd });
  const blocks = [];
  for (const [cd, blockRows] of groupBy(rows, (r) => r.block_cd)) {
    blocks.push({ blockCd: String(cd), blockName: blockRows[0].block_name, districtName: blockRows[0].district_name, ...sumRows(blockRows) });
  }
  blocks.sort((a, b) => b.pct - a.pct);
  return { date, blocks, districtName: blocks[0]?.districtName || 'Unknown' };
}

async function getLowAttendanceDistricts(date, threshold, scopeFilter = {}) {
  const { districts } = await getDistrictSummary(date, scopeFilter);
  return districts.filter((d) => d.pct < threshold);
}

async function getZeroAttendanceSchools(date, scopeFilter = {}) {
  date = date || todayIST();
  const rows = await querySchoolRows(date, scopeFilter);
  return rows
    .filter((r) => r.present_count === 0)
    .map((r) => ({ udise: r.udise_cd, name: r.school_name, district: r.district_name, block: r.block_name, totalTeachers: r.roster_count }));
}

async function getDistrictList(scopeFilter = {}) {
  const where = buildWhere(scopeFilter || {}, 1);
  const result = await pool.query(
    `SELECT DISTINCT r.district_cd::text AS district_cd, r.district_name
       FROM mv_school_roster r
      WHERE r.roster_count > 0${where.clauses.length ? ` AND ${where.clauses.join(' AND ')}` : ''}
      ORDER BY r.district_name`,
    where.params
  );
  return result.rows;
}

module.exports = {
  todayIST,
  getStateSummary,
  getDistrictSummary,
  getBlockSummary,
  getLowAttendanceDistricts,
  getZeroAttendanceSchools,
  getDistrictList,
  // exported for tests
  sumRows,
  buildWhere,
};
