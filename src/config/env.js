// src/config/env.js
//
// Single source of truth for environment variables. Required secrets have
// NO insecure fallback — the app refuses to boot rather than silently
// running with a known-weak default (e.g. a JWT secret that's been pasted
// into a chat, a doc, or a public repo).

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    // eslint-disable-next-line no-console
    console.error(`Missing required environment variable: ${name}. Refusing to start.`);
    process.exit(1);
  }
  return value;
};

const optional = (name, fallback) => process.env[name] || fallback;

const env = {
  NODE_ENV: optional('NODE_ENV', 'development'),
  PORT: Number(optional('PORT', 3000)),

  DATABASE_URL: required('DATABASE_URL'),
  JWT_SECRET: required('JWT_SECRET'),

  // Comma-separated list of origins allowed to call this API, e.g.
  // "https://naijaverify.com.ng,https://admin.naijaverify.com.ng"
  // If unset, CORS is permissive (logged loudly) — appropriate while the
  // frontend is a local file opened ad hoc, not once you have a fixed domain.
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : null,

  ADMIN_USERNAME: optional('ADMIN_USERNAME', 'admin'),
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || null, // checked at use-site, not at boot

  PREMBLY_BASE_URL: optional('PREMBLY_BASE_URL', 'https://api.prembly.com'),
  PREMBLY_SECRET_KEY: process.env.PREMBLY_SECRET_KEY || null,
  PREMBLY_TIMEOUT_MS: Number(optional('PREMBLY_TIMEOUT_MS', 10000)),
  PREMBLY_MAX_RETRIES: Number(optional('PREMBLY_MAX_RETRIES', 2)),

  MONNIFY_BASE_URL: optional('MONNIFY_BASE_URL', 'https://sandbox.monnify.com'),
  MONNIFY_API_KEY: process.env.MONNIFY_API_KEY || null,
  MONNIFY_SECRET_KEY: process.env.MONNIFY_SECRET_KEY || null,
  MONNIFY_CONTRACT_CODE: process.env.MONNIFY_CONTRACT_CODE || null,

  VTPASS_BASE_URL: optional('VTPASS_BASE_URL', 'https://sandbox.vtpass.com/api'),
  VTPASS_API_KEY: process.env.VTPASS_API_KEY || null,
  VTPASS_PUBLIC_KEY: process.env.VTPASS_PUBLIC_KEY || null,
  VTPASS_SECRET_KEY: process.env.VTPASS_SECRET_KEY || null,
  VTPASS_TIMEOUT_MS: Number(optional('VTPASS_TIMEOUT_MS', 15000)),

  PRICES: {
    'nin_verification_nin': Number(optional('PRICE_NIN_VERIFY_NIN', 300)),
    'nin_verification_phone': Number(optional('PRICE_NIN_VERIFY_PHONE', 200)),
    'nin_verification_demographic': Number(optional('PRICE_NIN_VERIFY_DEMOGRAPHIC', 200)),
    'bvn_verification_bvn': Number(optional('PRICE_BVN_VERIFY', 200)),
    'nin_modification_name': Number(optional('PRICE_NIN_MOD_NAME', 5000)),
    'nin_modification_phone': Number(optional('PRICE_NIN_MOD_PHONE', 5000))
  },

  RESET_TOKEN_TTL_MS: 60 * 60 * 1000
};

module.exports = env;
