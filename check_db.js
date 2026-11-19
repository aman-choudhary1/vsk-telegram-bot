require('dotenv').config();
const pool = require('./src/db');

(async () => {
  try {
    // 1. Check columns
    const cols = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'system_users' ORDER BY ordinal_position"
    );
    console.log('system_users columns:', cols.rows.map(x => x.column_name).join(', '));

    // 2. Sample data
    const data = await pool.query('SELECT * FROM system_users LIMIT 3');
    console.log('\nSample rows:');
    data.rows.forEach(r => console.log(JSON.stringify(r)));

    // 3. Check if mobile column exists
    const hasMobile = cols.rows.some(c => c.column_name === 'mobile');
    console.log('\nHas mobile column:', hasMobile);
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await pool.end();
  }
})();
