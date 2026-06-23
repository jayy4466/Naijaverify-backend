// src/middleware/rateLimiters.js
//
// WHY THIS FILE EXISTS (audit finding):
// The original server had no rate limiting anywhere. /api/auth/login and
// /api/admin/login could be hit as fast as the network allowed — a script
// could brute-force a customer's password, or worse, the single shared
// admin password, with no friction at all. /api/auth/forgot-password could
// be used to spam reset tokens or as a user-enumeration timing oracle at
// high volume. These limits don't fix everything (see SECURITY_AUDIT.md for
// the note on adding device fingerprinting / CAPTCHA if abuse continues),
// but they close the easiest, cheapest attack.

const rateLimit = require('express-rate-limit');

function makeAuthLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait a few minutes and try again.' }
  });
}

// Separate instances, not one shared one — otherwise hammering /login
// from an IP also exhausts the rate-limit budget for /register and
// /forgot-password from that same IP, which isn't the intended scope of
// "stop someone brute-forcing a login".
const loginLimiter = makeAuthLimiter();
const registerLimiter = makeAuthLimiter();
const forgotPasswordLimiter = makeAuthLimiter();
const resetPasswordLimiter = makeAuthLimiter();

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' }
});

// A looser, app-wide ceiling so no single client can hammer the API and
// degrade it for everyone else, while staying out of the way of normal use.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down.' }
});

module.exports = { loginLimiter, registerLimiter, forgotPasswordLimiter, resetPasswordLimiter, adminLoginLimiter, apiLimiter };
