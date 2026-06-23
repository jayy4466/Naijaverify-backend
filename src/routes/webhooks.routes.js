// src/routes/webhooks.routes.js
//
// New in this pass. Paste this URL into Monnify's dashboard under
// Developers > Webhook URLs > Transaction Completion:
//   https://<your-render-url>/api/webhooks/monnify
//
// This route is mounted with express.raw() (see app.js) instead of
// express.json() — signature verification needs the exact bytes Monnify
// sent, and JSON.parse + re-stringify is not guaranteed to reproduce them
// byte-for-byte (key order, whitespace).

const express = require('express');
const pool = require('../config/db');
const { verifyMonnifySignature } = require('../services/monnify.service');
const { creditWalletForPaymentReference } = require('../services/wallet.service');
const logger = require('../utils/logger');

const router = express.Router();

router.post('/monnify', async (req, res) => {
  const signature = req.headers['monnify-signature'];
  const rawBody = req.body; // Buffer, thanks to express.raw()

  if (!verifyMonnifySignature(rawBody, signature)) {
    logger.warn({ ip: req.ip }, 'Rejected Monnify webhook with invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // Monnify resends a notification if it doesn't get a 200 back, or on
  // timeout — track event IDs we've already handled so a resend can't
  // cause a duplicate credit. transactionReference is unique per attempt.
  const eventId = payload?.eventData?.transactionReference || payload?.eventData?.paymentReference;
  if (eventId) {
    try {
      await pool.query(
        `INSERT INTO processed_webhook_events (source, event_id) VALUES ('monnify', $1)`,
        [eventId]
      );
    } catch (err) {
      if (err.code === '23505') {
        // Unique violation — we've already processed this exact event.
        // Still acknowledge with 200 so Monnify doesn't keep retrying.
        logger.info({ eventId }, 'Duplicate Monnify webhook event ignored');
        return res.status(200).json({ message: 'Already processed' });
      }
      throw err;
    }
  }

  // Acknowledge quickly, per Monnify's own best practices — process after.
  res.status(200).json({ message: 'Webhook received' });

  if (payload.eventType === 'SUCCESSFUL_TRANSACTION' && payload.eventData?.paymentReference) {
    try {
      const result = await creditWalletForPaymentReference(payload.eventData.paymentReference);
      logger.info({ result, paymentReference: payload.eventData.paymentReference }, 'Processed Monnify webhook');
    } catch (err) {
      logger.error({ err: err.message, payload }, 'Failed to process Monnify webhook payment');
    }
  }
});

module.exports = router;
