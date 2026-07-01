// src/routes/requests.routes.js
const express = require('express');
const pool = require('../config/db');
const env = require('../config/env');
const { requireAuth } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { generateReferenceCode } = require('../utils/referenceCode');
const { verifyWithPrembly } = require('../services/prembly.service');
const { cleanText, isReasonableText } = require('../utils/validation');
const logger = require('../utils/logger');

const router = express.Router();

const VALID_COMBOS = {
  nin_verification: ['nin', 'phone', 'demographic'],
  bvn_verification: ['bvn'],
  nin_modification: ['name', 'phone', 'address', 'dob']
};
// Methods with a real, automated Prembly lookup behind them. Everything
// else queues for manual handling but still charges — you're paying for
// the lookup/correction attempt and effort either way.
const AUTOMATED_METHODS = new Set(['nin', 'bvn']);
const MAX_PICTURE_CHARS = 4 * 1024 * 1024; // ~3MB binary once base64-decoded

function getPrice(serviceType, requestType, method) {
  return env.PRICES[`${serviceType}_${requestType}_${method}`] ?? null;
}

router.post('/', requireAuth, async (req, res) => {
  const {
    service_type, request_type, method, full_name, phone,
    reference_input, surname, firstname, middlename, date_of_birth,
    new_phone_number, new_address, picture_base64
  } = req.body || {};

  const comboKey = `${service_type}_${request_type}`;
  const validMethods = VALID_COMBOS[comboKey];
  if (!validMethods) throw new AppError(400, 'Invalid service_type / request_type combination');
  if (!validMethods.includes(method)) {
    throw new AppError(400, `Invalid method for ${comboKey}. Expected one of: ${validMethods.join(', ')}`);
  }

  // Verification searches don't ask for the requester's name/phone on the
  // frontend anymore (already known from the logged-in account) — default
  // to the account's own details here too, as a second line of defense in
  // case a request ever arrives without them.
  let effectiveFullName = full_name;
  let effectivePhone = phone;
  if (request_type === 'verification' && (!effectiveFullName || !effectivePhone)) {
    const userRes = await pool.query('SELECT full_name, phone FROM users WHERE id = $1', [req.user.id]);
    effectiveFullName = effectiveFullName || userRes.rows[0].full_name;
    effectivePhone = effectivePhone || userRes.rows[0].phone;
  }

  if (!isReasonableText(effectiveFullName, { min: 2, max: 120 })) throw new AppError(400, 'A valid full name is required');
  if (!isReasonableText(effectivePhone, { min: 7, max: 20 })) throw new AppError(400, 'A valid phone number is required');

  // TODO (once an email provider is connected): require req.user to have
  // email_verified = true before allowing a paid request. Deliberately not
  // enforced yet — see auth.routes.js for why.

  if (method === 'nin' || method === 'bvn' || (method === 'phone' && request_type === 'verification')) {
    if (!isReasonableText(reference_input, { min: 5, max: 20 })) throw new AppError(400, 'A number to search is required');
  }
  if (method === 'demographic') {
    if (!isReasonableText(surname, { max: 80 }) || !isReasonableText(firstname, { max: 80 }) || !isReasonableText(date_of_birth, { max: 20 })) {
      throw new AppError(400, 'Surname, first name and date of birth are required for a demographic search');
    }
  }
  if (request_type === 'modification') {
    if (!isReasonableText(reference_input, { min: 5, max: 20 })) throw new AppError(400, 'The existing NIN is required');
    if (!picture_base64 || typeof picture_base64 !== 'string') throw new AppError(400, 'A supporting picture is required for a modification request');
    if (picture_base64.length > MAX_PICTURE_CHARS) throw new AppError(400, 'That picture is too large — please use a smaller image');
    if (method === 'name' && !surname && !firstname && !middlename) {
      throw new AppError(400, 'Provide at least one corrected name field');
    }
    if (method === 'phone' && !isReasonableText(new_phone_number, { min: 7, max: 20 })) {
      throw new AppError(400, 'The new phone number is required');
    }
    if (method === 'address' && !isReasonableText(new_address, { min: 5, max: 500 })) {
      throw new AppError(400, 'The corrected address is required');
    }
    if (method === 'dob' && !isReasonableText(date_of_birth, { max: 20 })) {
      throw new AppError(400, 'The corrected date of birth is required');
    }
  }

  const price = getPrice(service_type, request_type, method);
  if (price == null) throw new AppError(400, 'No price configured for this service — contact support');

  // Quick balance check up front, so we don't spend a real Prembly lookup
  // on a customer who can't pay for it anyway.
  const balCheck = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [req.user.id]);
  const currentBalance = Number(balCheck.rows[0].wallet_balance);
  if (currentBalance < price) {
    throw new AppError(402, `Insufficient wallet balance. This costs \u20a6${price}, your balance is \u20a6${currentBalance}. Please top up.`);
  }

  const reference_code = generateReferenceCode(service_type, request_type);
  let status = 'pending';
  let verification_result = null;
  let chargeable = true; // false only if our own Prembly call failed — that's on us, not the customer

  if (request_type === 'verification' && AUTOMATED_METHODS.has(method)) {
    try {
      const result = await verifyWithPrembly(service_type, reference_input);
      verification_result = result.summary;
      status = result.verified ? 'completed' : 'rejected';
    } catch (err) {
      logger.error({ err: err.message, service_type, method }, 'Prembly verification failed — queuing for manual follow-up');
      verification_result = { error: 'Verification service unavailable — will need manual follow-up' };
      status = 'pending';
      chargeable = false;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const lockRes = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    const balance = Number(lockRes.rows[0].wallet_balance);
    if (chargeable && balance < price) {
      await client.query('ROLLBACK');
      throw new AppError(402, `Insufficient wallet balance. This costs \u20a6${price}, your balance is \u20a6${balance}. Please top up.`);
    }

    const inserted = await client.query(
      `INSERT INTO service_requests
        (user_id, service_type, request_type, method, full_name, phone, reference_input,
         surname, firstname, middlename, date_of_birth, new_phone_number, new_address, picture_base64,
         verification_result, reference_code, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id, user_id, service_type, request_type, method, full_name, phone, reference_input,
         surname, firstname, middlename, date_of_birth, new_phone_number, new_address, verification_result,
         reference_code, status, created_at, updated_at`, // picture_base64 deliberately never echoed back
      [req.user.id, service_type, request_type, method, cleanText(effectiveFullName), cleanText(effectivePhone), reference_input || null,
       surname || null, firstname || null, middlename || null, date_of_birth || null,
       new_phone_number || null, new_address || null, picture_base64 || null, verification_result, reference_code, status]
    );
    const request = inserted.rows[0];

    let newBalance = balance;
    if (chargeable) {
      newBalance = balance - price;
      await client.query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [newBalance, req.user.id]);
      await client.query(
        `INSERT INTO wallet_transactions (user_id, type, amount, description, service_request_id, status)
         VALUES ($1, 'debit', $2, $3, $4, 'completed')`,
        [req.user.id, price, `${service_type.toUpperCase()} ${request_type} (${method}) \u2014 ${request.reference_code}`, request.id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ request, wallet_balance: newBalance, charged: chargeable ? price : 0 });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, user_id, service_type, request_type, method, full_name, phone, reference_input,
      surname, firstname, middlename, date_of_birth, new_phone_number, new_address, verification_result,
      reference_code, status, created_at, updated_at
     FROM service_requests WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json({ requests: result.rows });
});

module.exports = router;
