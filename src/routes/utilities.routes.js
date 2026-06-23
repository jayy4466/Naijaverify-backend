// src/routes/utilities.routes.js
const express = require('express');
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { isValidNigerianPhone } = require('../utils/validation');
const logger = require('../utils/logger');
const {
  generateRequestId, getDataVariations, purchaseAirtime, purchaseData
} = require('../services/vtpass.service');

const router = express.Router();

const NETWORKS = ['mtn', 'airtel', 'glo', '9mobile'];
const MIN_AIRTIME = 50;
const MAX_AIRTIME = 50000;
// A fixed, sensible preset list shown alongside the live data plans —
// matches how most vending apps present airtime (no "variation" concept
// for airtime, unlike data, so there's nothing to fetch from VTpass here).
const AIRTIME_PRESETS = [100, 200, 500, 1000, 2000, 5000];

router.get('/airtime-presets', requireAuth, (req, res) => {
  res.json({ presets: AIRTIME_PRESETS, min: MIN_AIRTIME, max: MAX_AIRTIME });
});

router.get('/data-plans', requireAuth, async (req, res) => {
  const { network } = req.query;
  if (!NETWORKS.includes(network)) throw new AppError(400, `network must be one of: ${NETWORKS.join(', ')}`);
  try {
    const variations = await getDataVariations(network);
    res.json({ network, variations });
  } catch (err) {
    logger.error({ err: err.message, network }, 'Failed to fetch VTpass data variations');
    throw new AppError(502, 'Could not load data plans right now — please try again shortly');
  }
});

router.get('/purchases', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM utility_purchases WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  );
  res.json({ purchases: result.rows });
});

router.post('/purchase', requireAuth, async (req, res) => {
  const { type, network, phone, amount, variation_code } = req.body || {};

  if (!['airtime', 'data'].includes(type)) throw new AppError(400, "type must be 'airtime' or 'data'");
  if (!NETWORKS.includes(network)) throw new AppError(400, `network must be one of: ${NETWORKS.join(', ')}`);
  if (!isValidNigerianPhone(phone)) throw new AppError(400, 'Please enter a valid Nigerian phone number');

  let chargeAmount;
  let variationName = null;

  if (type === 'airtime') {
    chargeAmount = Number(amount);
    if (!chargeAmount || chargeAmount < MIN_AIRTIME || chargeAmount > MAX_AIRTIME) {
      throw new AppError(400, `Airtime amount must be between \u20a6${MIN_AIRTIME} and \u20a6${MAX_AIRTIME}`);
    }
  } else {
    if (!variation_code) throw new AppError(400, 'variation_code is required for data purchases');
    const variations = await getDataVariations(network);
    const match = variations.find((v) => v.code === variation_code);
    if (!match) throw new AppError(400, 'Unknown data plan — please refresh and try again');
    chargeAmount = match.amount;
    variationName = match.name;
  }

  const balCheck = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [req.user.id]);
  const currentBalance = Number(balCheck.rows[0].wallet_balance);
  if (currentBalance < chargeAmount) {
    throw new AppError(402, `Insufficient wallet balance. This costs \u20a6${chargeAmount}, your balance is \u20a6${currentBalance}.`);
  }

  const requestId = generateRequestId();

  let vtpassResult;
  try {
    vtpassResult = type === 'airtime'
      ? await purchaseAirtime({ network, phone, amount: chargeAmount, requestId })
      : await purchaseData({ network, phone, variationCode: variation_code, requestId });
  } catch (err) {
    logger.error({ err: err.message, type, network }, 'VTpass purchase call failed outright');
    throw new AppError(502, 'Could not reach the airtime/data service — please try again shortly. You have not been charged.');
  }

  if (vtpassResult.status === 'failed') {
    await pool.query(
      `INSERT INTO utility_purchases (user_id, type, network, phone, amount, variation_code, variation_name, vtpass_request_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'failed')`,
      [req.user.id, type, network, phone, chargeAmount, variation_code || null, variationName, requestId]
    );
    throw new AppError(502, 'The purchase failed on the network side — you have not been charged. Please try again.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockRes = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    const balance = Number(lockRes.rows[0].wallet_balance);
    if (balance < chargeAmount) {
      await client.query('ROLLBACK');
      logger.error({ userId: req.user.id, requestId }, 'VTpass call succeeded but balance was insufficient at commit time — needs manual reconciliation');
      throw new AppError(402, 'Insufficient balance — please contact support, your purchase may already be processing.');
    }

    const inserted = await client.query(
      `INSERT INTO utility_purchases (user_id, type, network, phone, amount, variation_code, variation_name, vtpass_request_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user.id, type, network, phone, chargeAmount, variation_code || null, variationName, requestId, vtpassResult.status]
    );
    const newBalance = balance - chargeAmount;
    await client.query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [newBalance, req.user.id]);
    await client.query(
      `INSERT INTO wallet_transactions (user_id, type, amount, description, status)
       VALUES ($1, 'debit', $2, $3, 'completed')`,
      [req.user.id, chargeAmount, `${network.toUpperCase()} ${type} \u2014 ${variationName || phone}`]
    );
    await client.query('COMMIT');
    res.status(201).json({ purchase: inserted.rows[0], wallet_balance: newBalance });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
