// src/services/wallet.service.js
const pool = require('../config/db');
const logger = require('../utils/logger');
const { queryMonnifyTransaction } = require('./monnify.service');

const PAID_STATUSES = new Set(['PAID', 'OVERPAID']);
const TERMINAL_FAILURE_STATUSES = new Set(['FAILED', 'CANCELLED', 'ABANDONED', 'EXPIRED', 'REVERSED']);

/**
 * Idempotently credits a customer's wallet for a given Monnify payment
 * reference. Safe to call multiple times for the same reference — from the
 * redirect callback, from the webhook, or from both for the same payment —
 * because it always re-checks the transaction's stored status inside the
 * same DB transaction that would update it.
 *
 * Returns one of:
 *   { outcome: 'credited', amount }
 *   { outcome: 'already_credited' }
 *   { outcome: 'not_found' }
 *   { outcome: 'not_yet_paid', paymentStatus }
 *   { outcome: 'failed', paymentStatus }
 */
async function creditWalletForPaymentReference(paymentReference) {
  const txRes = await pool.query('SELECT * FROM wallet_transactions WHERE payment_reference = $1', [paymentReference]);
  const tx = txRes.rows[0];
  if (!tx) return { outcome: 'not_found' };
  if (tx.status === 'completed') return { outcome: 'already_credited' };

  const monnifyStatus = await queryMonnifyTransaction(paymentReference);

  if (PAID_STATUSES.has(monnifyStatus.paymentStatus)) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Re-read with a row lock inside the transaction — closes the race
      // where the callback and the webhook arrive at nearly the same time
      // and both pass the status === 'completed' check above before either
      // has committed.
      const lockedRes = await client.query(
        'SELECT * FROM wallet_transactions WHERE id = $1 FOR UPDATE',
        [tx.id]
      );
      const locked = lockedRes.rows[0];
      if (locked.status === 'completed') {
        await client.query('ROLLBACK');
        return { outcome: 'already_credited' };
      }
      await client.query('UPDATE wallet_transactions SET status = $1 WHERE id = $2', ['completed', tx.id]);
      await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [tx.amount, tx.user_id]);
      await client.query('COMMIT');
      logger.info({ paymentReference, userId: tx.user_id, amount: tx.amount }, 'Wallet credited');
      return { outcome: 'credited', amount: Number(tx.amount) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  if (TERMINAL_FAILURE_STATUSES.has(monnifyStatus.paymentStatus)) {
    await pool.query('UPDATE wallet_transactions SET status = $1 WHERE id = $2', ['failed', tx.id]);
    return { outcome: 'failed', paymentStatus: monnifyStatus.paymentStatus };
  }

  return { outcome: 'not_yet_paid', paymentStatus: monnifyStatus.paymentStatus };
}

module.exports = { creditWalletForPaymentReference };
