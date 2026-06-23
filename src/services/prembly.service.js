// src/services/prembly.service.js
//
// WHY THIS CHANGED (audit finding):
// The original implementation called fetch() with no timeout and no retry.
// Two concrete problems with that:
//   1. If Prembly's API hangs (slow response, network stall), our request
//      handler hangs too — indefinitely, since Node's fetch has no default
//      timeout. One slow upstream call ties up a connection until the
//      platform's own (much longer) timeout kicks in.
//   2. A single transient failure (a dropped connection, a 502 from
//      Prembly's load balancer) was treated as a permanent failure and
//      immediately fell back to "pending — manual follow-up", even though
//      retrying once usually would have succeeded and given the customer
//      an instant result instead of a delay.
//
// Fix: AbortController-based timeout, plus a small retry budget with
// exponential backoff for retryable failures (timeouts, network errors,
// 5xx) — NOT for 4xx, since retrying a request Prembly already rejected as
// invalid just wastes a paid API call.

const env = require('../config/env');
const logger = require('../utils/logger');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postWithRetry(url, options, { timeoutMs, maxRetries }) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      if (response.status >= 500 && attempt < maxRetries) {
        lastError = new Error(`Prembly returned ${response.status}`);
        await sleep(2 ** attempt * 300);
        continue;
      }
      return response;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < maxRetries) {
        logger.warn({ attempt, err: err.message }, 'Prembly call failed, retrying');
        await sleep(2 ** attempt * 300);
        continue;
      }
    }
  }
  throw lastError;
}

// Returns { verified, summary }. summary is what we persist — deliberately
// excludes the photo Prembly returns for NIN lookups (we don't need to
// store biometric data we have no use for, and not storing it is one less
// thing that could go wrong if the database were ever exposed).
async function verifyWithPrembly(serviceType, number) {
  if (!env.PREMBLY_SECRET_KEY) {
    return { verified: false, summary: { error: 'Verification service is not configured (missing PREMBLY_SECRET_KEY)' } };
  }

  const path = serviceType === 'nin' ? '/verification/vnin-basic' : '/verification/bvn_validation';

  let response;
  try {
    response = await postWithRetry(
      env.PREMBLY_BASE_URL + path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': env.PREMBLY_SECRET_KEY },
        body: JSON.stringify({ number })
      },
      { timeoutMs: env.PREMBLY_TIMEOUT_MS, maxRetries: env.PREMBLY_MAX_RETRIES }
    );
  } catch (err) {
    logger.error({ err: err.message, serviceType }, 'Prembly call failed after retries');
    throw err; // caller decides how to handle (route marks the request pending for manual follow-up)
  }

  const data = await response.json();
  const ok = response.ok && data.status === true && data.response_code === '00';

  if (serviceType === 'nin') {
    const n = data.nin_data || {};
    return {
      verified: ok,
      summary: {
        detail: data.detail,
        firstname: n.firstname,
        middlename: n.middlename,
        surname: n.surname,
        birthdate: n.birthdate,
        gender: n.gender,
        telephoneno: n.telephoneno
      }
    };
  }

  const d = data.data || {};
  return {
    verified: ok,
    summary: {
      detail: data.detail,
      firstName: d.firstName,
      middleName: d.middleName,
      lastName: d.surname,
      dateOfBirth: d.dateOfBirth,
      phoneNumber: d.phoneNumber
    }
  };
}

module.exports = { verifyWithPrembly };
