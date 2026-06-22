// src/config/db.js
const { Pool } = require('pg');
const env = require('./env');

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  // A background/idle client error should never crash the whole process.
  // eslint-disable-next-line global-require
  require('../utils/logger').error({ err }, 'Unexpected error on idle database client');
});

module.exports = pool;
