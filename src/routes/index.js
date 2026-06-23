// src/routes/index.js
const express = require('express');
const authRoutes = require('./auth.routes');
const walletRoutes = require('./wallet.routes');
const requestsRoutes = require('./requests.routes');
const adminRoutes = require('./admin.routes');
const utilitiesRoutes = require('./utilities.routes');

const router = express.Router();

router.get('/health', (req, res) => res.json({ ok: true }));
router.use('/auth', authRoutes);
router.use('/wallet', walletRoutes);
router.use('/requests', requestsRoutes);
router.use('/admin', adminRoutes);
router.use('/utilities', utilitiesRoutes);

module.exports = router;
