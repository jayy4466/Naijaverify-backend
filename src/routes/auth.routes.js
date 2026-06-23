// src/routes/auth.routes.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const env = require('../config/env');
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { loginLimiter, registerLimiter, forgotPasswordLimiter, resetPasswordLimiter } = require('../middleware/rateLimiters');
const { AppError } = require('../middleware/errorHandler');
const { generateToken } = require('../utils/referenceCode');
const { isValidEmail, isValidNigerianPhone, isReasonableText, cleanText, requireFields } = require('../utils/validation');

const router = express.Router();

function publicUser(row) {
  return {
    id: row.id,
    full_name: row.full_name,
    email: row.email,
    phone: row.phone,
    email_verified: row.email_verified
  };
}

router.post('/register', registerLimiter, async (req, res) => {
  requireFields(req.body, ['full_name', 'email', 'password']);
  const full_name = cleanText(req.body.full_name);
  const email = String(req.body.email).trim().toLowerCase();
  const phone = req.body.phone ? cleanText(req.body.phone) : null;
  const { password } = req.body;

  if (!isReasonableText(full_name, { min: 2, max: 120 })) throw new AppError(400, 'Please enter a valid full name');
  if (!isValidEmail(email)) throw new AppError(400, 'Please enter a valid email address');
  if (phone && !isValidNigerianPhone(phone)) throw new AppError(400, 'Please enter a valid Nigerian phone number');
  if (typeof password !== 'string' || password.length < 6) throw new AppError(400, 'Password must be at least 6 characters');

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length) throw new AppError(409, 'An account with that email already exists');

  const password_hash = bcrypt.hashSync(password, 12);
  const verificationToken = generateToken(24);

  const inserted = await pool.query(
    `INSERT INTO users (full_name, email, phone, password_hash, email_verification_token)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [full_name, email, phone, password_hash, verificationToken]
  );
  const user = inserted.rows[0];

  // No email provider is connected yet — this is the same placeholder
  // pattern used for password resets. Email verification is NOT currently
  // enforced anywhere (see requests.routes.js) precisely because customers
  // have no real way to receive this link yet. Once a provider is wired
  // in, swap this log line for a real send and flip on enforcement.
  logger.info({ email, verificationToken }, '[email verification] link would be sent here');

  const token = jwt.sign({ id: user.id, email: user.email }, env.JWT_SECRET, { expiresIn: '7d' });
  res.status(201).json({ token, user: publicUser(user) });
});

router.post('/login', loginLimiter, async (req, res) => {
  requireFields(req.body, ['email', 'password']);
  const email = String(req.body.email).trim().toLowerCase();
  const { password } = req.body;

  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = result.rows[0];
  // Always run bcrypt.compareSync even when no user is found, against a
  // fixed dummy hash — otherwise "unknown email" returns faster than
  // "wrong password", which lets an attacker enumerate which emails are
  // registered just by measuring response time.
  const hashToCheck = user ? user.password_hash : '$2a$12$invalidinvalidinvalidinvalidinvalidinO';
  const passwordMatches = bcrypt.compareSync(password, hashToCheck);

  if (!user || !passwordMatches) throw new AppError(401, 'Invalid email or password');

  const token = jwt.sign({ id: user.id, email: user.email }, env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: publicUser(user) });
});

router.get('/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) throw new AppError(400, 'Missing verification token');
  const result = await pool.query(
    `UPDATE users SET email_verified = TRUE, email_verification_token = NULL
     WHERE email_verification_token = $1 RETURNING id, email`,
    [token]
  );
  if (!result.rows.length) throw new AppError(400, 'Invalid or already-used verification link');
  res.json({ message: 'Email verified', email: result.rows[0].email });
});

router.get('/me', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!result.rows.length) throw new AppError(404, 'User not found');
  res.json({ user: publicUser(result.rows[0]) });
});

router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  requireFields(req.body, ['email']);
  const email = String(req.body.email).trim().toLowerCase();
  const genericMessage = 'If an account exists for that address, a reset link is on its way.';

  const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = userRes.rows[0];

  if (user) {
    const token = generateToken(32);
    const expiresAt = new Date(Date.now() + env.RESET_TOKEN_TTL_MS).toISOString();
    await pool.query('DELETE FROM password_resets WHERE user_id = $1', [user.id]);
    await pool.query('INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)', [user.id, token, expiresAt]);
    logger.info({ email, token }, '[password reset] link would be sent here');
  }

  // Always the same response whether or not the email matched, and on a
  // similar code path either way — so this endpoint can't be used to find
  // out which emails are registered.
  res.json({ message: genericMessage });
});

router.post('/reset-password', resetPasswordLimiter, async (req, res) => {
  requireFields(req.body, ['token', 'password']);
  const { token, password } = req.body;
  if (typeof password !== 'string' || password.length < 6) throw new AppError(400, 'Password must be at least 6 characters');

  const result = await pool.query('SELECT * FROM password_resets WHERE token = $1', [token]);
  const reset = result.rows[0];
  if (!reset) throw new AppError(400, 'Invalid or already-used reset code');
  if (new Date(reset.expires_at) < new Date()) {
    await pool.query('DELETE FROM password_resets WHERE id = $1', [reset.id]);
    throw new AppError(400, 'This reset code has expired — request a new one');
  }

  const password_hash = bcrypt.hashSync(password, 12);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [password_hash, reset.user_id]);
  await pool.query('DELETE FROM password_resets WHERE user_id = $1', [reset.user_id]);

  res.json({ message: 'Password updated' });
});

module.exports = router;
