// src/utils/referenceCode.js
const crypto = require('crypto');

function generateReferenceCode(serviceType, requestType) {
  const typeCode = requestType === 'modification' ? 'MOD' : 'VER';
  const prefix = `${serviceType.toUpperCase()}-${typeCode}`;
  // crypto.randomInt is a CSPRNG — Math.random() is not, and while a
  // guessable reference code isn't a critical vulnerability on its own
  // (it doesn't grant access to anything by itself), there's no reason to
  // use a weaker source of randomness when a stronger one is free.
  const num = String(crypto.randomInt(0, 99999)).padStart(5, '0');
  return `NV-${prefix}-${num}`;
}

function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = { generateReferenceCode, generateToken };
