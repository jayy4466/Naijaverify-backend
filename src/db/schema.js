// src/db/schema.js
//
// Idempotent schema setup, run once at boot. CREATE TABLE IF NOT EXISTS +
// ALTER ... ADD COLUMN IF NOT EXISTS means this is always safe to re-run,
// including against a database created by an older version of this app.

const pool = require('../config/db');
const logger = require('../utils/logger');

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT,
      password_hash TEXT NOT NULL,
      wallet_balance NUMERIC NOT NULL DEFAULT 0 CHECK (wallet_balance >= 0),
      email_verified BOOLEAN NOT NULL DEFAULT FALSE,
      email_verification_token TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS service_requests (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      service_type TEXT NOT NULL CHECK (service_type IN ('nin','bvn')),
      request_type TEXT NOT NULL CHECK (request_type IN ('verification','modification')),
      method TEXT NOT NULL CHECK (method IN ('nin','phone','demographic','bvn','name')),
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      reference_input TEXT,
      surname TEXT,
      firstname TEXT,
      middlename TEXT,
      date_of_birth TEXT,
      new_phone_number TEXT,
      picture_base64 TEXT,
      verification_result JSONB,
      reference_code TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','rejected')),
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      CHECK (NOT (service_type = 'bvn' AND request_type = 'modification'))
    );

    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('credit','debit')),
      amount NUMERIC NOT NULL CHECK (amount > 0),
      description TEXT,
      payment_reference TEXT UNIQUE,
      service_request_id INTEGER REFERENCES service_requests(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending','completed','failed')),
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS admin_action_log (
      id SERIAL PRIMARY KEY,
      admin_username TEXT NOT NULL,
      action TEXT NOT NULL,
      service_request_id INTEGER REFERENCES service_requests(id) ON DELETE SET NULL,
      detail JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS processed_webhook_events (
      id SERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (source, event_id)
    );

    CREATE TABLE IF NOT EXISTS utility_purchases (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('airtime','data')),
      network TEXT NOT NULL CHECK (network IN ('mtn','airtel','glo','9mobile')),
      phone TEXT NOT NULL,
      amount NUMERIC NOT NULL CHECK (amount > 0),
      variation_code TEXT,
      variation_name TEXT,
      vtpass_request_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Defensive migrations for databases created by earlier versions of this app.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token TEXT;`);
  await pool.query(`ALTER TABLE service_requests ALTER COLUMN reference_input DROP NOT NULL;`);
  await pool.query(`
    ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS method TEXT;
    ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS surname TEXT;
    ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS firstname TEXT;
    ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS middlename TEXT;
    ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS date_of_birth TEXT;
    ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS new_phone_number TEXT;
    ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS picture_base64 TEXT;
  `);
  // verification_result used to be stored as TEXT (a JSON.stringify'd string).
  // JSONB is more correct — it validates the data is real JSON and lets you
  // query inside it later. This cast is a safe no-op if already JSONB.
  await pool.query(`
    ALTER TABLE service_requests
    ALTER COLUMN verification_result TYPE JSONB USING verification_result::JSONB;
  `);

  // Indexes. Postgres already indexes PRIMARY KEY and UNIQUE columns
  // automatically (id, email, reference_code, payment_reference) — these
  // cover the lookups that weren't already covered by one of those.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_service_requests_user_id ON service_requests(user_id);
    CREATE INDEX IF NOT EXISTS idx_service_requests_status ON service_requests(status);
    CREATE INDEX IF NOT EXISTS idx_service_requests_created_at ON service_requests(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_id ON wallet_transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_service_request_id ON wallet_transactions(service_request_id);
    CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id);
    CREATE INDEX IF NOT EXISTS idx_utility_purchases_user_id ON utility_purchases(user_id);
  `);

  logger.info('Database schema is up to date');
}

module.exports = { initSchema };
