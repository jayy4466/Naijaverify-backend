// src/utils/logger.js
//
// Structured logging instead of raw console.log scattered through the app.
// Why this matters in production: Render/Railway log viewers and any future
// log aggregator (Datadog, Logtail, etc.) work far better with structured
// JSON than with ad-hoc strings, and `redact` stops us from ever accidentally
// logging a password, token, or full picture payload even if a future change
// passes the wrong object into a log call.

const pino = require('pino');
const env = require('../config/env');

const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.body.password',
      'req.body.picture_base64',
      'password',
      'password_hash',
      'picture_base64',
      '*.password',
      '*.password_hash',
      '*.picture_base64'
    ],
    censor: '[redacted]'
  },
  transport: env.NODE_ENV === 'production'
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
});

module.exports = logger;
