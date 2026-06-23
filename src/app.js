// src/app.js
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');

const env = require('./config/env');
const logger = require('./utils/logger');
const { apiLimiter } = require('./middleware/rateLimiters');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const apiRoutes = require('./routes');
const webhookRoutes = require('./routes/webhooks.routes');

const app = express();

// Trust Render/Railway's proxy so req.protocol and req.ip reflect the real
// client, not the internal proxy hop — needed for the redirectUrl we build
// in wallet.routes.js to come out as https:// instead of http://.
app.set('trust proxy', 1);

app.use(helmet({
  // This API serves only JSON, never HTML, so a strict default CSP that
  // would otherwise need tuning for inline scripts/styles is irrelevant —
  // disabling it here avoids fighting Helmet over a header this API
  // doesn't need, without weakening anything that matters for a JSON API.
  contentSecurityPolicy: false
}));

app.use(pinoHttp({ logger }));

// CORS: permissive by default because the frontend is currently a static
// HTML file opened directly (file://, or from wherever it's hosted next),
// so there's no fixed origin to allow-list yet. Once the frontend has a
// real, fixed domain, set ALLOWED_ORIGINS and this locks down automatically
// with zero code changes.
if (env.ALLOWED_ORIGINS) {
  app.use(cors({ origin: env.ALLOWED_ORIGINS }));
} else {
  logger.warn('ALLOWED_ORIGINS is not set — CORS is open to all origins. Set it once the frontend has a fixed domain.');
  app.use(cors());
}

// IMPORTANT: the webhook route needs the raw request body to verify
// Monnify's signature, and must be registered with its own body parser
// BEFORE the general express.json() below — once express.json() consumes
// the request stream for a path, the raw bytes are gone. Registering this
// specific route first means it gets first refusal on matching requests.
app.use('/api/webhooks', express.raw({ type: 'application/json', limit: '1mb' }), webhookRoutes);

app.use(express.json({ limit: '6mb' })); // headroom for base64 picture uploads
app.use(apiLimiter);

app.use('/api', apiRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
