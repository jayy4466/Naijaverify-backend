// src/services/monnify.service.js
//
// WHY THIS CHANGED (audit finding):
// The original integration only confirmed payments via the redirect
// callback the customer's browser hits after checkout. That's NOT
// forgeable as-is (the callback re-verifies with Monnify's own status API
// before crediting anything — that part was already done right), but it IS
// unreliable: if the customer closes the tab, loses signal, or the browser
// never completes the redirect, the payment is real but the wallet never
// gets credited, with no way to find out except the customer complaining.
//
// Fix: add a webhook receiver as a second, independent path to the same
// crediting logic, verified using Monnify's documented HMAC-SHA512
// signature scheme (header: monnify-signature, key: secret key, data: raw
// request body). A forged webhook without the secret key cannot produce a
// valid signature, so this is safe to trust once verified.

const crypto = require('crypto');
const env = require('../config/env');

async function getMonnifyToken() {
  const credentials = Buffer.from(`${env.MONNIFY_API_KEY}:${env.MONNIFY_SECRET_KEY}`).toString('base64');
  const response = await fetch(`${env.MONNIFY_BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { Authorization: `Basic ${credentials}` }
  });
  const data = await response.json();
  if (!data.requestSuccessful) throw new Error(data.responseMessage || 'Monnify authentication failed');
  return data.responseBody.accessToken;
}

async function initMonnifyTransaction({ amount, customerName, customerEmail, paymentReference, redirectUrl }) {
  const token = await getMonnifyToken();
  const response = await fetch(`${env.MONNIFY_BASE_URL}/api/v1/merchant/transactions/init-transaction`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount,
      customerName,
      customerEmail,
      paymentReference,
      paymentDescription: 'NaijaVerify wallet top-up',
      currencyCode: 'NGN',
      contractCode: env.MONNIFY_CONTRACT_CODE,
      redirectUrl,
      paymentMethods: ['CARD', 'ACCOUNT_TRANSFER']
    })
  });
  const data = await response.json();
  if (!data.requestSuccessful) throw new Error(data.responseMessage || 'Could not start the payment');
  return data.responseBody;
}

async function queryMonnifyTransaction(paymentReference) {
  const token = await getMonnifyToken();
  const response = await fetch(
    `${env.MONNIFY_BASE_URL}/api/v2/merchant/transactions/query?paymentReference=${encodeURIComponent(paymentReference)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await response.json();
  if (!data.requestSuccessful) throw new Error(data.responseMessage || 'Could not check payment status');
  return data.responseBody;
}

// `rawBody` MUST be the exact bytes Monnify sent (see routes/webhooks.routes.js
// for why this needs express.raw() instead of express.json() on this one route) —
// re-serializing a parsed JSON object can produce a byte-for-byte different
// string (key order, whitespace) and break the signature check even on a
// genuine, unmodified webhook.
function verifyMonnifySignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const expected = crypto
    .createHmac('sha512', env.MONNIFY_SECRET_KEY)
    .update(rawBody)
    .digest('hex');
  // Constant-time comparison — a plain === here would let an attacker
  // measure response-time differences to guess the correct signature one
  // byte at a time (a timing attack).
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { initMonnifyTransaction, queryMonnifyTransaction, verifyMonnifySignature };
