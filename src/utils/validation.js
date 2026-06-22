// src/utils/validation.js
//
// WHY THIS FILE EXISTS (audit finding):
// The original code's idea of "validation" was `if (!full_name) return 400`.
// Nothing checked email format, phone format, string length, or stripped
// control characters. That meant: invalid emails could register accounts
// (and silently break password-reset emails later), and — more seriously —
// nothing stopped a free-text field like full_name from containing HTML,
// which the admin dashboard then injected straight into the page via
// innerHTML. That's a stored XSS vector: a malicious "customer" could set
// their name to a <script> payload and have it execute in the admin's
// browser the next time they viewed the request queue.
//
// Fix: validate format/length on the way in, and (see admin.html) escape
// everything on the way out too — defense in depth, not just one or the other.

const validator = require('validator');
const { AppError } = require('../middleware/errorHandler');

function isValidEmail(email) {
  return typeof email === 'string' && validator.isEmail(email) && email.length <= 254;
}

// Nigerian phone numbers: 11 digits starting with 0, or +234 followed by 10 digits.
function isValidNigerianPhone(phone) {
  if (typeof phone !== 'string') return false;
  const cleaned = phone.replace(/[\s-]/g, '');
  return /^0\d{10}$/.test(cleaned) || /^\+234\d{10}$/.test(cleaned);
}

function isReasonableText(value, { min = 1, max = 200 } = {}) {
  return typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
}

// Strips control characters and trims — applied to every free-text field
// before it touches the database. This does NOT replace output escaping
// (still required, since legitimate names can contain characters that are
// dangerous in an HTML context, e.g. an apostrophe-based name); it just
// stops obviously malformed/control-character input from being stored at all.
function cleanText(value) {
  if (typeof value !== 'string') return value;
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
}

function requireFields(body, fields) {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      throw new AppError(400, `${field} is required`);
    }
  }
}

module.exports = { isValidEmail, isValidNigerianPhone, isReasonableText, cleanText, requireFields };
