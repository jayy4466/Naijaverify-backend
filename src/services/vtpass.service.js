// src/services/vtpass.service.js
//
// Airtime/data vending via VTpass. Sandbox docs publish specific test phone
// numbers that simulate every outcome (success/pending/timeout/failure) —
// used directly in this file's tests rather than guessed at.
//
// Auth (per VTpass docs): GET requests use headers api-key + public-key.
// POST requests use headers api-key + secret-key.

const env = require('../config/env');
const logger = require('../utils/logger');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// VTpass requires the request_id's first 12 characters to be numeric and
// to encode today's date+time (Africa/Lagos / GMT+1), e.g. 202606221430.
function generateRequestId() {
  const now = new Date(Date.now() + 60 * 60 * 1000); // UTC+1 (Lagos has no DST)
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${stamp}${suffix}`;
}

async function vtpassFetch(path, { method = 'GET', body, authType }) {
  const headers = { 'Content-Type': 'application/json', 'api-key': env.VTPASS_API_KEY };
  headers[authType === 'post' ? 'secret-key' : 'public-key'] = authType === 'post' ? env.VTPASS_SECRET_KEY : env.VTPASS_PUBLIC_KEY;

  let lastError;
  for (let attempt = 0; attempt <= 1; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.VTPASS_TIMEOUT_MS);
    try {
      const response = await fetch(env.VTPASS_BASE_URL + path, {
        method, headers, signal: controller.signal, body: body ? JSON.stringify(body) : undefined
      });
      clearTimeout(timer);
      return await response.json();
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      // Only retry GET (variation lookups) — never retry a POST purchase.
      // Retrying a /pay call that may have actually gone through risks a
      // double recharge; a query-status call does not carry that risk.
      if (method === 'GET' && attempt === 0) {
        logger.warn({ err: err.message }, 'VTpass GET failed, retrying once');
        await sleep(500);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

const NETWORK_SERVICE_IDS = { mtn: 'mtn', airtel: 'airtel', glo: 'glo', '9mobile': 'etisalat' };
const NETWORK_DATA_SERVICE_IDS = { mtn: 'mtn-data', airtel: 'airtel-data', glo: 'glo-data', '9mobile': 'etisalat-data' };

// Cached in memory, refreshed every hour — data plans don't change minute
// to minute, and this avoids hitting VTpass on every page load.
const variationCache = new Map(); // network -> { fetchedAt, variations }
const CACHE_TTL_MS = 60 * 60 * 1000;

async function getDataVariations(network) {
  const cached = variationCache.get(network);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.variations;

  const serviceID = NETWORK_DATA_SERVICE_IDS[network];
  if (!serviceID) throw new Error(`Unknown network: ${network}`);

  const data = await vtpassFetch(`/service-variations?serviceID=${serviceID}`, { authType: 'get' });
  const variations = (data?.content?.variations || []).map((v) => ({
    code: v.variation_code,
    name: v.name,
    amount: Number(v.variation_amount)
  }));
  variationCache.set(network, { fetchedAt: Date.now(), variations });
  return variations;
}

function interpretVtpassResponse(data) {
  const status = data?.content?.transactions?.status;
  if (data?.code === '000' && (status === 'delivered' || data?.response_description === 'TRANSACTION SUCCESSFUL')) {
    return 'completed';
  }
  if (status === 'pending' || data?.response_description === 'TRANSACTION IS PENDING') return 'pending';
  return 'failed';
}

async function purchaseAirtime({ network, phone, amount, requestId }) {
  const serviceID = NETWORK_SERVICE_IDS[network];
  if (!serviceID) throw new Error(`Unknown network: ${network}`);
  const data = await vtpassFetch('/pay', {
    method: 'POST', authType: 'post',
    body: { request_id: requestId, serviceID, amount, phone }
  });
  return { status: interpretVtpassResponse(data), raw: data };
}

async function purchaseData({ network, phone, variationCode, requestId }) {
  const serviceID = NETWORK_DATA_SERVICE_IDS[network];
  if (!serviceID) throw new Error(`Unknown network: ${network}`);
  const data = await vtpassFetch('/pay', {
    method: 'POST', authType: 'post',
    body: { request_id: requestId, serviceID, billersCode: phone, variation_code: variationCode, phone }
  });
  return { status: interpretVtpassResponse(data), raw: data };
}

async function requeryTransaction(requestId) {
  const data = await vtpassFetch('/requery', { method: 'POST', authType: 'post', body: { request_id: requestId } });
  return { status: interpretVtpassResponse(data), raw: data };
}

module.exports = { generateRequestId, getDataVariations, purchaseAirtime, purchaseData, requeryTransaction, NETWORK_SERVICE_IDS };
