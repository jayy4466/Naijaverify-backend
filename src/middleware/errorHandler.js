// src/middleware/errorHandler.js
const logger = require('../utils/logger');
const env = require('../config/env');

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Express 5 forwards rejected promises from async route handlers here
// automatically, so every route can just `throw` or reject without a
// try/catch wrapper around every single handler.
function errorHandler(err, req, res, _next) {
  const status = err.status || 500;

  logger.error({ err, path: req.path, method: req.method, status }, err.message);

  // Never leak internals (stack traces, raw DB error text) to the client —
  // only the message on deliberately-thrown AppErrors is safe to show,
  // everything else gets a generic message.
  const safeMessage = err.status ? err.message : 'Something went wrong on our end';
  const body = { error: safeMessage };
  if (env.NODE_ENV !== 'production' && !err.status) {
    body.detail = err.message; // helpful locally, never in prod
  }
  res.status(status).json(body);
}

function notFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}

module.exports = { errorHandler, notFound, AppError };
