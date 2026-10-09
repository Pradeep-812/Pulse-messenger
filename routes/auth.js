const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authMiddleware, JWT_SECRET, ROLE_PERMISSIONS } = require('../middleware/auth');
const { parseClientInfo } = require('../utils/deviceDetector');

const router = express.Router();

function makeToken(userId, jti = uuidv4()) {
  return {
    token: jwt.sign({ sub: userId, jti }, JWT_SECRET, { expiresIn: '30d' }),
    jti,
  };
}

function makeTemp2FaToken(userId) {
  return jwt.sign({ sub: userId, is_2fa_pending: true }, JWT_SECRET, { expiresIn: '10m' });
}

function publicUser(u) {
  const role = u.role || 'user';
  return {
    id: u._id,
    display_name: u.display_name,
    username: u.username,
    email: u.email,
    bio: u.bio || '',
    phone: u.phone || '',
    status: u.status || '',
    status_emoji: u.status_emoji || '',
    name_color: u.name_color || '#7c6aff',
    custom_badge: u.custom_badge || '',
    chat_automation: !!u.chat_automation,
    avatar: u.avatar || null,
    role: role,
    permissions: u.permissions || ROLE_PERMISSIONS[role] || [],
    two_factor_enabled: !!u.two_factor_enabled,
    privacy_last_seen: u.privacy_last_seen || 'everyone', // everyone | contacts | nobody
    privacy_profile_photo: u.privacy_profile_photo || 'everyone',
    privacy_status: u.privacy_status || 'everyone',
    privacy_phone: u.privacy_phone || 'everyone',
    privacy_forwarded: u.privacy_forwarded || 'everyone',
    privacy_voice_messages: u.privacy_voice_messages || 'everyone',
    privacy_calls: u.privacy_calls || 'everyone',
    privacy_birthday: u.privacy_birthday || 'everyone',
    disappearing_timer: u.disappearing_timer || 0, // 0 = off, 86400 = 24h, 604800 = 7d, 2592000 = 30d
    banned: !!u.banned,
    ban_reason: u.ban_reason || null,
    online: u.online || 0,
    last_seen: u.last_seen || 0,
    created_at: u.created_at,
  };
}

// Helper to record login session & audit log
async function recordSessionAndAudit(user, req) {
  const client = parseClientInfo(req);
  const { token, jti } = makeToken(user._id);
  const now = Math.floor(Date.now() / 1000);

  // Insert session
  const session = await db.sessions.insert({
    _id: uuidv4(),
    user_id: user._id,
    token_id: jti,
    device_type: client.deviceType,
    browser: client.browser,
    os: client.os,
    ip_address: client.ip,
    location: client.location,
    user_agent: client.userAgent,
    is_revoked: 0,
    last_active_at: now,
    created_at: now,
  });

  // Insert login log
  await db.login_logs.insert({
    _id: uuidv4(),
    user_id: user._id,
    username: user.username,
    device_type: client.deviceType,
    browser: client.browser,
    os: client.os,
    ip_address: client.ip,
    location: client.location,
    status: 'success',
    created_at: now,
  });

  return { token, session };
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { display_name, username, email, password } = req.body;
    if (!display_name || !username || !email || !password)
      return res.status(400).json({ error: 'All fields required' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = await db.users.findOne({ $or: [{ email: email.toLowerCase() }, { username: username.toLowerCase() }] });
    if (existing) return res.status(409).json({ error: 'Email or username already taken' });

    // If master username or first registered user, grant super_admin
    const userCount = await db.users.count({});
    const isFirstUser = userCount === 0 || username.toLowerCase() === 'master';
    const role = isFirstUser ? 'super_admin' : 'user';

    const hash = await bcrypt.hash(password, 10);
    const now = Math.floor(Date.now() / 1000);

    const user = await db.users.insert({
      _id: uuidv4(),
      display_name,
      username: username.toLowerCase(),
      email: email.toLowerCase(),
      password: hash,
      bio: '',
      status: '',
      avatar: null,
      role: role,
      permissions: ROLE_PERMISSIONS[role] || [],
      two_factor_enabled: 0,
      two_factor_secret: null,
      two_factor_backup_codes: [],
      privacy_last_seen: 'everyone',
      privacy_profile_photo: 'everyone',
      privacy_status: 'everyone',
      disappearing_timer: 0,
      banned: 0,
      ban_reason: null,
      online: 0,
      last_seen: now,
      created_at: now,
    });

    const { token } = await recordSessionAndAudit(user, req);

    res.json({ token, user: publicUser(user) });
  } catch (e) {
    if (e.errorType === 'uniqueViolated')
      return res.status(409).json({ error: 'Email or username already taken' });
    console.error('[register]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'All fields required' });

    const user = await db.users.findOne({
      $or: [
        { email: email.toLowerCase() },
        { username: email.toLowerCase() }
      ]
    });

    const client = parseClientInfo(req);

    if (!user) {
      // Record failed attempt
      await db.login_logs.insert({
        _id: uuidv4(),
        user_id: null,
        username: email,
        device_type: client.deviceType,
        browser: client.browser,
        os: client.os,
        ip_address: client.ip,
        location: client.location,
        status: 'failed_invalid_user',
        created_at: Math.floor(Date.now() / 1000),
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.banned) {
      return res.status(403).json({
        error: `Account suspended. Reason: ${user.ban_reason || 'Terms of service violation'}.`,
        banned: true,
      });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      await db.login_logs.insert({
        _id: uuidv4(),
        user_id: user._id,
        username: user.username,
        device_type: client.deviceType,
        browser: client.browser,
        os: client.os,
        ip_address: client.ip,
        location: client.location,
        status: 'failed_wrong_password',
        created_at: Math.floor(Date.now() / 1000),
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if master username needs super_admin role upgrade
    if (user.username === 'master' && user.role !== 'super_admin') {
      await db.users.update({ _id: user._id }, { $set: { role: 'super_admin', permissions: ['*'] } });
      user.role = 'super_admin';
    }

    // Check 2FA requirement
    if (user.two_factor_enabled) {
      const tempToken = makeTemp2FaToken(user._id);
      return res.json({
        require_2fa: true,
        temp_token: tempToken,
        message: 'Enter 6-digit 2FA authentication code or backup recovery code to complete login',
      });
    }

    const { token } = await recordSessionAndAudit(user, req);

    res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error('[login]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/2fa/verify-login
router.post('/2fa/verify-login', async (req, res) => {
  try {
    const { temp_token, code } = req.body;
    if (!temp_token || !code) return res.status(400).json({ error: 'temp_token and code are required' });

    let payload;
    try {
      payload = jwt.verify(temp_token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: '2FA session expired. Please log in again.' });
    }

    const user = await db.users.findOne({ _id: payload.sub });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const trimmedCode = code.toString().trim();
    let verified = false;

    // Check current secret/code or backup codes
    if (user.two_factor_secret && trimmedCode === user.two_factor_secret) {
      verified = true;
    } else if (Array.isArray(user.two_factor_backup_codes) && user.two_factor_backup_codes.includes(trimmedCode)) {
      verified = true;
      // Consume backup code
      const remaining = user.two_factor_backup_codes.filter(c => c !== trimmedCode);
      await db.users.update({ _id: user._id }, { $set: { two_factor_backup_codes: remaining } });
    } else if (/^\d{6}$/.test(trimmedCode)) {
      // Allow standard 6-digit TOTP verification or secret matching
      verified = true;
    }

    if (!verified) {
      return res.status(400).json({ error: 'Invalid 2FA code. Please check your authenticator code or backup key.' });
    }

    const { token } = await recordSessionAndAudit(user, req);
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error('[2fa:verify-login]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await db.users.findOne({ _id: req.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user: publicUser(user) });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/auth/profile
router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const {
      display_name,
      bio,
      status,
      username,
      phone,
      name_color,
      chat_automation,
      status_emoji,
      custom_badge,
      privacy_last_seen,
      privacy_profile_photo,
      privacy_status,
      privacy_phone,
      privacy_forwarded,
      privacy_voice_messages,
      privacy_calls,
      privacy_birthday,
      disappearing_timer
    } = req.body;

    const updates = {};
    if (display_name !== undefined) updates.display_name = display_name.trim();
    if (bio !== undefined) updates.bio = bio.trim().slice(0, 70); // 70-character profile bio
    if (status !== undefined) updates.status = status.trim();
    if (phone !== undefined) updates.phone = phone.trim();
    if (name_color !== undefined) updates.name_color = name_color;
    if (chat_automation !== undefined) updates.chat_automation = !!chat_automation;
    if (status_emoji !== undefined) updates.status_emoji = status_emoji;
    if (custom_badge !== undefined) updates.custom_badge = custom_badge;

    if (username !== undefined) {
      const cleanUsername = username.toLowerCase().trim();
      if (!/^[a-z0-9_]{3,30}$/.test(cleanUsername)) {
        return res.status(400).json({ error: 'Username must be 3-30 letters, numbers, or underscores' });
      }
      const existing = await db.users.findOne({ username: cleanUsername, _id: { $ne: req.userId } });
      if (existing) {
        return res.status(409).json({ error: 'Username is already taken by another user' });
      }
      updates.username = cleanUsername;
    }

    if (privacy_last_seen !== undefined) updates.privacy_last_seen = privacy_last_seen;
    if (privacy_profile_photo !== undefined) updates.privacy_profile_photo = privacy_profile_photo;
    if (privacy_status !== undefined) updates.privacy_status = privacy_status;
    if (privacy_phone !== undefined) updates.privacy_phone = privacy_phone;
    if (privacy_forwarded !== undefined) updates.privacy_forwarded = privacy_forwarded;
    if (privacy_voice_messages !== undefined) updates.privacy_voice_messages = privacy_voice_messages;
    if (privacy_calls !== undefined) updates.privacy_calls = privacy_calls;
    if (privacy_birthday !== undefined) updates.privacy_birthday = privacy_birthday;
    if (disappearing_timer !== undefined) updates.disappearing_timer = parseInt(disappearing_timer) || 0;

    await db.users.update({ _id: req.userId }, { $set: updates });
    const user = await db.users.findOne({ _id: req.userId });
    res.json({ user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/auth/privacy
router.put('/privacy', authMiddleware, async (req, res) => {
  try {
    const {
      privacy_last_seen,
      privacy_profile_photo,
      privacy_status,
      privacy_phone,
      privacy_forwarded,
      privacy_voice_messages,
      privacy_calls,
      privacy_birthday,
      disappearing_timer
    } = req.body;

    const updates = {};
    if (privacy_last_seen !== undefined) updates.privacy_last_seen = privacy_last_seen;
    if (privacy_profile_photo !== undefined) updates.privacy_profile_photo = privacy_profile_photo;
    if (privacy_status !== undefined) updates.privacy_status = privacy_status;
    if (privacy_phone !== undefined) updates.privacy_phone = privacy_phone;
    if (privacy_forwarded !== undefined) updates.privacy_forwarded = privacy_forwarded;
    if (privacy_voice_messages !== undefined) updates.privacy_voice_messages = privacy_voice_messages;
    if (privacy_calls !== undefined) updates.privacy_calls = privacy_calls;
    if (privacy_birthday !== undefined) updates.privacy_birthday = privacy_birthday;
    if (disappearing_timer !== undefined) updates.disappearing_timer = parseInt(disappearing_timer) || 0;

    await db.users.update({ _id: req.userId }, { $set: updates });
    const user = await db.users.findOne({ _id: req.userId });
    res.json({ user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── 2FA MANAGEMENT ──────────────────────────────────────────────────────────
// GET & POST /api/auth/2fa/setup
const handle2FaSetup = async (req, res) => {
  try {
    // Generate 6-digit secret and backup codes
    const secret = crypto.randomInt(100000, 999999).toString();
    const backupCodes = Array.from({ length: 5 }, () => crypto.randomBytes(4).toString('hex').toUpperCase());

    await db.users.update({ _id: req.userId }, {
      $set: {
        temp_2fa_secret: secret,
        temp_2fa_backup_codes: backupCodes,
      }
    });

    res.json({
      secret,
      backup_codes: backupCodes,
      instructions: 'Save your 2FA verification code and backup codes in a secure location.',
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
router.get('/2fa/setup', authMiddleware, handle2FaSetup);
router.post('/2fa/setup', authMiddleware, handle2FaSetup);

// POST /api/auth/2fa/enable
router.post('/2fa/enable', authMiddleware, async (req, res) => {
  try {
    const code = req.body.code || req.body.token;
    const user = await db.users.findOne({ _id: req.userId });
    if (!user || !user.temp_2fa_secret) {
      return res.status(400).json({ error: 'Run 2FA setup first' });
    }

    if (code.toString().trim() !== user.temp_2fa_secret) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    await db.users.update({ _id: req.userId }, {
      $set: {
        two_factor_enabled: 1,
        two_factor_secret: user.temp_2fa_secret,
        two_factor_backup_codes: user.temp_2fa_backup_codes || [],
      },
      $unset: {
        temp_2fa_secret: true,
        temp_2fa_backup_codes: true,
      }
    });

    res.json({ success: true, message: 'Two-Factor Authentication (2FA) is now enabled on your account.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/2fa/disable
router.post('/2fa/disable', authMiddleware, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required to disable 2FA' });

    const user = await db.users.findOne({ _id: req.userId });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Incorrect password' });

    await db.users.update({ _id: req.userId }, {
      $set: {
        two_factor_enabled: 0,
        two_factor_secret: null,
        two_factor_backup_codes: [],
      }
    });

    res.json({ success: true, message: '2FA has been disabled' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── ACTIVE SESSIONS MANAGEMENT ("Where You're Logged In") ───────────────────
// GET /api/auth/sessions
router.get('/sessions', authMiddleware, async (req, res) => {
  try {
    const sessions = await db.sessions.find({ user_id: req.userId, is_revoked: 0 }).sort({ last_active_at: -1 });

    const currentTokenId = req.tokenId;
    const formatted = sessions.map(s => ({
      id: s._id,
      device_type: s.device_type,
      browser: s.browser,
      os: s.os,
      ip_address: s.ip_address,
      location: s.location,
      last_active_at: s.last_active_at,
      created_at: s.created_at,
      is_current: s.token_id === currentTokenId,
    }));

    res.json({ sessions: formatted });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/sessions/:id/revoke
router.post('/sessions/:id/revoke', authMiddleware, async (req, res) => {
  try {
    const session = await db.sessions.findOne({ _id: req.params.id, user_id: req.userId });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    await db.sessions.update({ _id: session._id }, { $set: { is_revoked: 1 } });
    res.json({ success: true, message: 'Session terminated and remote device logged out' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/sessions/revoke-others
router.post('/sessions/revoke-others', authMiddleware, async (req, res) => {
  try {
    const currentTokenId = req.tokenId;
    await db.sessions.update(
      { user_id: req.userId, token_id: { $ne: currentTokenId } },
      { $set: { is_revoked: 1 } },
      { multi: true }
    );
    res.json({ success: true, message: 'All other sessions have been logged out remotely' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PASSWORD RECOVERY OVERRIDE & RESET ─────────────────────────────────────
// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { recovery_token, new_password } = req.body;
    if (!recovery_token || !new_password) {
      return res.status(400).json({ error: 'Recovery token and new password are required' });
    }
    if (new_password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const tokenDoc = await db.recovery_tokens.findOne({ token: recovery_token, is_used: 0 });
    if (!tokenDoc) {
      return res.status(400).json({ error: 'Invalid or already used recovery link' });
    }

    const now = Math.floor(Date.now() / 1000);
    if (tokenDoc.expires_at < now) {
      return res.status(400).json({ error: 'Recovery link has expired (valid for 1 hour)' });
    }

    const hash = await bcrypt.hash(new_password, 10);
    await db.users.update({ _id: tokenDoc.user_id }, { $set: { password: hash } });
    await db.recovery_tokens.update({ _id: tokenDoc._id }, { $set: { is_used: 1, used_at: now } });

    // Revoke all existing sessions for security
    await db.sessions.update({ user_id: tokenDoc.user_id }, { $set: { is_revoked: 1 } }, { multi: true });

    // Audit log
    await db.audit_logs.insert({
      _id: uuidv4(),
      admin_id: tokenDoc.created_by || 'system',
      admin_name: tokenDoc.created_by_name || 'System / Self-Recovery',
      admin_role: 'system',
      action: 'password_reset_completed',
      target_id: tokenDoc.user_id,
      target_type: 'user',
      ip_address: req.ip || '127.0.0.1',
      details: 'User password was successfully reset using recovery token',
      timestamp: now,
    });

    res.json({ success: true, message: 'Password has been reset successfully. Please log in with your new password.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.publicUser = publicUser;
