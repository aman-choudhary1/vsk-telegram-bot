const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: '-c TimeZone=Asia/Kolkata',
  max: 4,                       // bot has very light concurrency
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error', err.message);
});

module.exports = pool;
