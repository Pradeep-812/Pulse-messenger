const crypto = require('crypto');

// 256-bit key derived from environment secret
const SECRET = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || 'pulse_messenger_secure_e2ee_salt_key_2026';
const SALT = 'pulse_messenger_e2ee_salt';
const KEY = crypto.scryptSync(SECRET, SALT, 32);
const ALGORITHM = 'aes-256-gcm';

/**
 * Encrypt plaintext string using AES-256-GCM.
 * Stored format: enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>
 */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return plaintext;
  if (typeof plaintext !== 'string') plaintext = String(plaintext);
  if (!plaintext) return '';

  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `enc:v1:${iv.toString('hex')}:${authTag}:${encrypted}`;
  } catch (err) {
    console.error('[crypto:encrypt] error:', err.message);
    return plaintext;
  }
}

/**
 * Decrypt string if it was encrypted with encrypt().
 * If not in enc:v1 format, returns text unchanged (backward compatible).
 */
function decrypt(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string') return ciphertext;
  if (!ciphertext.startsWith('enc:v1:')) return ciphertext;

  try {
    const parts = ciphertext.split(':');
    if (parts.length !== 5) return ciphertext;
    const iv = Buffer.from(parts[2], 'hex');
    const authTag = Buffer.from(parts[3], 'hex');
    const encryptedData = parts[4];

    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('[crypto:decrypt] decryption failed:', err.message);
    return '[Encrypted Message]';
  }
}

function isEncrypted(text) {
  return typeof text === 'string' && text.startsWith('enc:v1:');
}

module.exports = {
  encrypt,
  decrypt,
  isEncrypted,
};
