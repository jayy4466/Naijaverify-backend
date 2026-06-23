// src/routes/admin.routes.js
const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const env = require('../config/env');
const { requireAdmin } = require('../middleware/auth');
const { adminLoginLimiter } = require('../middleware/rateLimiters');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();

router.post('/login', adminLoginLimiter, (req, res) => {
  if (!env.ADMIN_PASSWORD) throw new AppError(503, 'Admin login is not configured on this server');
  const { username, password } = req.body || {};
  if (username !== env.ADMIN_USERNAME || password !== env.ADMIN_PASSWORD) {
    throw new AppError(401, 'Invalid credentials');
  }
  const token = jwt.sign({ admin: true, username }, env.JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

// GET /api/admin/requests?status=pending&search=08011110000&page=1&pageSize=20
router.get('/requests', requireAdmin, async (req, res) => {
  const { status, search } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const offset = (page - 1) * pageSize;

  const conditions = [];
  const params = [];

  if (status && ['pending', 'processing', 'completed', 'rejected'].includes(status)) {
    params.push(status);
    conditions.push(`sr.status = $${params.length}`);
  }
  if (search && typeof search === 'string' && search.trim()) {
    params.push(`%${search.trim()}%`);
    const p = `$${params.length}`;
    conditions.push(`(sr.reference_code ILIKE ${p} OR sr.full_name ILIKE ${p} OR sr.phone ILIKE ${p} OR u.email ILIKE ${p})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRes = await pool.query(
    `SELECT COUNT(*) FROM service_requests sr JOIN users u ON u.id = sr.user_id ${where}`,
    params
  );

  params.push(pageSize, offset);
  const result = await pool.query(
    `SELECT sr.*, u.email AS customer_email,
       (SELECT COUNT(*) FROM wallet_transactions wt WHERE wt.service_request_id = sr.id AND wt.type = 'credit') AS already_refunded
     FROM service_requests sr
     JOIN users u ON u.id = sr.user_id
     ${where}
     ORDER BY (sr.status = 'pending') DESC, sr.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  res.json({
    requests: result.rows,
    pagination: { page, pageSize, total: Number(countRes.rows[0].count), totalPages: Math.ceil(Number(countRes.rows[0].count) / pageSize) }
  });
});

router.get('/stats', requireAdmin, async (req, res) => {
  const [statusCounts, revenue, refunds, todayCount] = await Promise.all([
    pool.query(`SELECT status, COUNT(*) FROM service_requests GROUP BY status`),
    pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM wallet_transactions WHERE type = 'debit' AND status = 'completed'`),
    pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM wallet_transactions WHERE type = 'credit' AND status = 'completed' AND service_request_id IS NOT NULL`),
    pool.query(`SELECT COUNT(*) FROM service_requests WHERE created_at >= CURRENT_DATE`)
  ]);

  const byStatus = { pending: 0, processing: 0, completed: 0, rejected: 0 };
  statusCounts.rows.forEach((r) => { byStatus[r.status] = Number(r.count); });

  res.json({
    requestsByStatus: byStatus,
    totalRevenue: Number(revenue.rows[0].total),
    totalRefunded: Number(refunds.rows[0].total),
    netRevenue: Number(revenue.rows[0].total) - Number(refunds.rows[0].total),
    requestsToday: Number(todayCount.rows[0].count)
  });
});

router.post('/requests/:id/complete', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new AppError(400, 'Invalid request id');

  const result = await pool.query(
    `UPDATE service_requests SET status = 'completed', updated_at = now() WHERE id = $1 RETURNING *`,
    [id]
  );
  if (!result.rows.length) throw new AppError(404, 'Request not found');

  await pool.query(
    `INSERT INTO admin_action_log (admin_username, action, service_request_id) VALUES ($1, 'complete', $2)`,
    [req.admin.username, id]
  );

  res.json({ request: result.rows[0] });
});

router.post('/requests/:id/reject', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new AppError(400, 'Invalid request id');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const reqRes = await client.query('SELECT * FROM service_requests WHERE id = $1 FOR UPDATE', [id]);
    if (!reqRes.rows.length) {
      await client.query('ROLLBACK');
      throw new AppError(404, 'Request not found');
    }
    const request = reqRes.rows[0];

    const alreadyRefunded = await client.query(
      `SELECT id FROM wallet_transactions WHERE service_request_id = $1 AND type = 'credit'`,
      [id]
    );

    let refunded = 0;
    if (!alreadyRefunded.rows.length) {
      const debitRes = await client.query(
        `SELECT amount FROM wallet_transactions WHERE service_request_id = $1 AND type = 'debit' AND status = 'completed'`,
        [id]
      );
      if (debitRes.rows.length) {
        refunded = Number(debitRes.rows[0].amount);
        await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [refunded, request.user_id]);
        await client.query(
          `INSERT INTO wallet_transactions (user_id, type, amount, description, service_request_id, status)
           VALUES ($1, 'credit', $2, $3, $4, 'completed')`,
          [request.user_id, refunded, `Refund \u2014 request failed: ${request.reference_code}`, id]
        );
      }
    }

    const updated = await client.query(
      `UPDATE service_requests SET status = 'rejected', updated_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );

    await client.query(
      `INSERT INTO admin_action_log (admin_username, action, service_request_id, detail) VALUES ($1, 'reject', $2, $3)`,
      [req.admin.username, id, JSON.stringify({ refunded })]
    );

    await client.query('COMMIT');
    res.json({ request: updated.rows[0], refunded });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
