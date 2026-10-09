const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authMiddleware, requireRole, requirePermission, ROLE_PERMISSIONS } = require('../middleware/auth');
const { publicUser } = require('./auth');

const JWT_SECRET = process.env.JWT_SECRET || 'pulse_secret_key_2024';
const router = express.Router();

// Helper to log immutable admin actions
async function recordAdminAudit(req, action, targetId, targetType, details) {
  try {
    await db.audit_logs.insert({
      _id: uuidv4(),
      admin_id: req.userId,
      admin_name: req.user?.display_name || req.user?.username || 'Admin',
      admin_role: req.userRole || 'super_admin',
      action,
      target_id: targetId,
      target_type: targetType,
      ip_address: req.ip || req.headers['x-forwarded-for'] || '127.0.0.1',
      details: typeof details === 'object' ? JSON.stringify(details) : details,
      timestamp: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    console.error('[audit_log_error]', err);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. GRANULAR RBAC & USER MANAGEMENT
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/admin/users - List users with roles, activity, and ban status
router.get('/users', authMiddleware, requireRole('super_admin', 'content_moderator', 'support_staff'), async (req, res) => {
  try {
    const users = await db.users.find({}).sort({ created_at: -1 });
    const formatted = users.map(u => ({
      ...publicUser(u),
      email: u.email,
      role: u.role || 'user',
      permissions: u.permissions || ROLE_PERMISSIONS[u.role || 'user'] || [],
      banned: !!u.banned,
      ban_reason: u.ban_reason || null,
      two_factor_enabled: !!u.two_factor_enabled,
      created_at: u.created_at,
    }));
    res.json({ users: formatted });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/admin/users/:id/role - Assign role and granular permissions (Super Admin only)
router.put('/users/:id/role', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const { role, custom_permissions } = req.body;
    const validRoles = ['super_admin', 'content_moderator', 'support_staff', 'user'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Allowed: ${validRoles.join(', ')}` });
    }

    const targetUser = await db.users.findOne({ _id: req.params.id });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const permissions = custom_permissions || ROLE_PERMISSIONS[role] || [];
    await db.users.update({ _id: targetUser._id }, {
      $set: { role, permissions }
    });

    await recordAdminAudit(req, 'change_role', targetUser._id, 'user', {
      previous_role: targetUser.role,
      new_role: role,
      permissions,
    });

    res.json({ success: true, message: `Updated user role to ${role}`, role, permissions });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/users/:id/ban - Ban user
router.post('/users/:id/ban', authMiddleware, requireRole('super_admin', 'content_moderator'), async (req, res) => {
  try {
    const { reason } = req.body;
    const targetUser = await db.users.findOne({ _id: req.params.id });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    // Protect Super Admin from being banned
    if (targetUser.role === 'super_admin' && req.userRole !== 'super_admin') {
      return res.status(403).json({ error: 'Cannot ban a Super Admin' });
    }

    const now = Math.floor(Date.now() / 1000);
    await db.users.update({ _id: targetUser._id }, {
      $set: {
        banned: 1,
        ban_reason: reason || 'Violation of Community Guidelines',
        banned_at: now,
        banned_by: req.userId,
      }
    });

    // Revoke all active sessions
    await db.sessions.update({ user_id: targetUser._id }, { $set: { is_revoked: 1 } }, { multi: true });

    // Disconnect any active sockets
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${targetUser._id}`).emit('session:revoked', { reason: 'Account has been suspended by administration' });
    }

    await recordAdminAudit(req, 'ban_user', targetUser._id, 'user', { reason: reason || 'Community Guidelines' });

    res.json({ success: true, message: `User @${targetUser.username} has been banned.` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/users/:id/unban - Unban user
router.post('/users/:id/unban', authMiddleware, requireRole('super_admin', 'content_moderator'), async (req, res) => {
  try {
    const targetUser = await db.users.findOne({ _id: req.params.id });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    await db.users.update({ _id: targetUser._id }, {
      $set: { banned: 0, ban_reason: null, banned_at: null, banned_by: null }
    });

    await recordAdminAudit(req, 'unban_user', targetUser._id, 'user', { action: 'unban' });

    res.json({ success: true, message: `User @${targetUser.username} has been reinstated.` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/users/:id/force-logout - Remote Force Logout
router.post('/users/:id/force-logout', authMiddleware, requireRole('super_admin', 'support_staff'), async (req, res) => {
  try {
    const targetUser = await db.users.findOne({ _id: req.params.id });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    await db.sessions.update({ user_id: targetUser._id }, { $set: { is_revoked: 1 } }, { multi: true });

    const io = req.app.get('io');
    if (io) {
      io.to(`user:${targetUser._id}`).emit('session:revoked', { reason: 'Logged out by Support Administration' });
    }

    await recordAdminAudit(req, 'force_logout', targetUser._id, 'user', { action: 'revoked_all_sessions' });

    res.json({ success: true, message: `All active sessions for @${targetUser.username} have been terminated.` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/users/:id/generate-recovery-link - Generate secure password recovery link
router.post('/users/:id/generate-recovery-link', authMiddleware, requireRole('super_admin', 'support_staff'), async (req, res) => {
  try {
    const targetUser = await db.users.findOne({ _id: req.params.id });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const token = crypto.randomBytes(32).toString('hex');
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 3600; // 1 hour validity

    await db.recovery_tokens.insert({
      _id: uuidv4(),
      user_id: targetUser._id,
      token,
      created_by: req.userId,
      created_by_name: req.user?.display_name || req.user?.username,
      is_used: 0,
      created_at: now,
      expires_at: expiresAt,
    });

    const host = req.get('host') || 'localhost:3000';
    const protocol = req.protocol || 'http';
    const recoveryUrl = `${protocol}://${host}/#reset-password=${token}`;

    await recordAdminAudit(req, 'generate_recovery_link', targetUser._id, 'user', {
      username: targetUser.username,
      expires_at: expiresAt,
    });

    res.json({
      success: true,
      recovery_url: recoveryUrl,
      recovery_token: token,
      expires_in: '1 hour',
      instructions: 'Share this secure one-time link with the verified account holder.',
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. USER SESSIONS & ACTIVITY MONITOR (AUDIT LOGS)
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/admin/users/:id/sessions - View user's device, browser, IP history
router.get('/users/:id/sessions', authMiddleware, requireRole('super_admin', 'support_staff'), async (req, res) => {
  try {
    const [sessions, loginLogs] = await Promise.all([
      db.sessions.find({ user_id: req.params.id }).sort({ last_active_at: -1 }),
      db.login_logs.find({ user_id: req.params.id }).sort({ created_at: -1 }).limit(30),
    ]);

    res.json({ sessions, login_logs: loginLogs });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. CONTENT REPORTING & MODERATION QUEUE (INSTAGRAM REPORTS CENTER)
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/admin/reports - Queue of reported messages, stories, users
router.get('/reports', authMiddleware, requireRole('super_admin', 'content_moderator'), async (req, res) => {
  try {
    const status = req.query.status || 'pending'; // 'pending' | 'resolved' | 'all'
    const query = status === 'all' ? {} : { status };

    const reports = await db.reports.find(query).sort({ created_at: -1 });
    res.json({ reports });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/reports/:id/resolve - Accept or Dismiss report
router.post('/reports/:id/resolve', authMiddleware, requireRole('super_admin', 'content_moderator'), async (req, res) => {
  try {
    const { action, note } = req.body; // 'delete_content', 'ban_user', 'warn_user', 'dismiss'
    const report = await db.reports.findOne({ _id: req.params.id });
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const now = Math.floor(Date.now() / 1000);

    if (action === 'delete_content') {
      if (report.target_type === 'message') {
        await db.messages.update({ _id: report.target_id }, { $set: { deleted: 1, content: 'This message was removed by moderator' } });
      } else if (report.target_type === 'story') {
        await db.stories.remove({ _id: report.target_id });
      }
    } else if (action === 'ban_user') {
      if (report.reported_user_id) {
        await db.users.update({ _id: report.reported_user_id }, {
          $set: { banned: 1, ban_reason: `Moderation report: ${report.reason}`, banned_at: now, banned_by: req.userId }
        });
        await db.sessions.update({ user_id: report.reported_user_id }, { $set: { is_revoked: 1 } }, { multi: true });
      }
    }

    await db.reports.update({ _id: report._id }, {
      $set: {
        status: 'resolved',
        resolution_action: action,
        reviewer_note: note || '',
        reviewed_by: req.userId,
        reviewed_by_name: req.user?.display_name || req.user?.username,
        reviewed_at: now,
      }
    });

    await recordAdminAudit(req, 'resolve_report', report._id, 'report', {
      action,
      target_type: report.target_type,
      target_id: report.target_id,
      reported_user: report.reported_user_id,
    });

    res.json({ success: true, message: `Report processed with action: ${action}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. AUTOMATED KEYWORD & SPAM FILTERS
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/admin/spam-filters
router.get('/spam-filters', authMiddleware, requireRole('super_admin', 'content_moderator'), async (req, res) => {
  try {
    const filters = await db.spam_filters.find({}).sort({ created_at: -1 });
    res.json({ filters });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/spam-filters
router.post('/spam-filters', authMiddleware, requireRole('super_admin', 'content_moderator'), async (req, res) => {
  try {
    const rawKw = req.body.keyword || req.body.pattern;
    const { category, action } = req.body;
    if (!rawKw) return res.status(400).json({ error: 'Keyword or phrase required' });

    const newFilter = await db.spam_filters.insert({
      _id: uuidv4(),
      keyword: rawKw.toLowerCase().trim(),
      category: category || 'offensive_words', // 'offensive_words' | 'toxic_links' | 'spam_phrases'
      action: action || 'flag_and_hide', // 'flag_and_hide' | 'auto_delete' | 'flag_only'
      created_by: req.userId,
      created_at: Math.floor(Date.now() / 1000),
    });

    await recordAdminAudit(req, 'create_spam_filter', newFilter._id, 'spam_filter', { keyword: rawKw, category, action });

    res.json({ success: true, filter: newFilter });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/admin/spam-filters/:id
router.delete('/spam-filters/:id', authMiddleware, requireRole('super_admin', 'content_moderator'), async (req, res) => {
  try {
    await db.spam_filters.remove({ _id: req.params.id });
    await recordAdminAudit(req, 'delete_spam_filter', req.params.id, 'spam_filter', {});
    res.json({ success: true, message: 'Filter deleted' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. USER ENGAGEMENT & ACTIVITY ANALYTICS (INSTAGRAM INSIGHTS STYLE)
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/admin/analytics - DAU, MAU, retention, traffic distribution, storage metrics
router.get('/analytics', authMiddleware, requireRole('super_admin', 'content_moderator', 'support_staff'), async (req, res) => {
  try {
    const now = Math.floor(Date.now() / 1000);
    const dayAgo = now - 86400;
    const monthAgo = now - (30 * 86400);

    const [
      totalUsers,
      totalMessages,
      totalConversations,
      totalStories,
      pendingReports,
      activeSessionsCount,
      allUsers,
      recentMessages,
    ] = await Promise.all([
      db.users.count({}),
      db.messages.count({}),
      db.conversations.count({}),
      db.stories.count({}),
      db.reports.count({ status: 'pending' }),
      db.sessions.count({ is_revoked: 0 }),
      db.users.find({}),
      db.messages.find({ created_at: { $gt: monthAgo } }).sort({ created_at: -1 }),
    ]);

    // DAU (Users active in last 24h)
    const dau = allUsers.filter(u => u.last_seen >= dayAgo || u.online === 1).length;
    // MAU (Users active in last 30 days)
    const mau = allUsers.filter(u => u.last_seen >= monthAgo || u.online === 1).length;

    // Daily signups in last 7 days
    const signupsByDay = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - (i * 86400 * 1000));
      const key = d.toISOString().split('T')[0];
      signupsByDay[key] = 0;
    }
    allUsers.forEach(u => {
      if (u.created_at) {
        const d = new Date(u.created_at * 1000).toISOString().split('T')[0];
        if (signupsByDay[d] !== undefined) signupsByDay[d]++;
      }
    });

    // Peak traffic distribution (hourly buckets 0 - 23)
    const hourlyTraffic = Array(24).fill(0);
    recentMessages.forEach(m => {
      const hour = new Date(m.created_at * 1000).getHours();
      hourlyTraffic[hour]++;
    });

    // Storage analytics (measure data & uploads dirs)
    let uploadBytes = 0;
    const uploadDir = path.join(__dirname, '../uploads');
    if (fs.existsSync(uploadDir)) {
      const files = fs.readdirSync(uploadDir);
      files.forEach(f => {
        try {
          const stats = fs.statSync(path.join(uploadDir, f));
          uploadBytes += stats.size;
        } catch (_) {}
      });
    }

    res.json({
      metrics: {
        total_users: totalUsers,
        total_messages: totalMessages,
        total_conversations: totalConversations,
        total_stories: totalStories,
        pending_reports: pendingReports,
        active_sessions: activeSessionsCount,
        dau,
        mau,
        retention_rate: totalUsers ? Math.min(100, Math.round((dau / totalUsers) * 100)) : 0,
        storage_upload_mb: (uploadBytes / (1024 * 1024)).toFixed(2),
      },
      charts: {
        signups_past_7_days: signupsByDay,
        hourly_traffic_distribution: hourlyTraffic,
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. IMMUTABLE ADMIN ACTION AUDIT TRAIL
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/admin/audit-logs
router.get('/audit-logs', authMiddleware, requireRole('super_admin', 'content_moderator'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 200);
    const logs = await db.audit_logs.find({}).sort({ timestamp: -1 }).limit(limit);
    res.json({ logs });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. GDPR DATA EXPORT & PURGE TOOL
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/admin/users/:id/export-data - Download Your Information
router.get('/users/:id/export-data', authMiddleware, requireRole('super_admin', 'support_staff'), async (req, res) => {
  try {
    const user = await db.users.findOne({ _id: req.params.id });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [messages, stories, sessions, memberships] = await Promise.all([
      db.messages.find({ sender_id: user._id }),
      db.stories.find({ user_id: user._id }),
      db.sessions.find({ user_id: user._id }),
      db.members.find({ user_id: user._id }),
    ]);

    const archive = {
      export_version: '1.0',
      exported_at: new Date().toISOString(),
      user_profile: publicUser(user),
      activity_statistics: {
        total_messages_sent: messages.length,
        total_stories_posted: stories.length,
        total_login_sessions: sessions.length,
        conversations_joined: memberships.length,
      },
      conversations_history: memberships,
      messages: messages.map(m => ({
        id: m._id,
        conversation_id: m.conversation_id,
        type: m.type,
        content: m.content,
        created_at: m.created_at,
        file_url: m.file_url,
      })),
      stories,
      login_sessions: sessions,
    };

    await recordAdminAudit(req, 'gdpr_export_data', user._id, 'user', { username: user.username });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="pulse-gdpr-export-${user.username}-${Date.now()}.json"`);
    res.send(JSON.stringify(archive, null, 2));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/admin/users/:id/purge - Permanent account & data purge
router.delete('/users/:id/purge', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const targetUser = await db.users.findOne({ _id: req.params.id });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    if (targetUser.role === 'super_admin' && targetUser._id === req.userId) {
      return res.status(400).json({ error: 'Cannot self-purge root Super Admin' });
    }

    const userId = targetUser._id;

    // 1. Remove user record
    await db.users.remove({ _id: userId });
    // 2. Anonymize sent messages
    await db.messages.update(
      { sender_id: userId },
      { $set: { sender_name: 'Deleted User', content: 'Account deleted' } },
      { multi: true }
    );
    // 3. Remove stories, sessions, subscriptions, reactions, reads, blocks
    await Promise.all([
      db.stories.remove({ user_id: userId }, { multi: true }),
      db.sessions.remove({ user_id: userId }, { multi: true }),
      db.login_logs.remove({ user_id: userId }, { multi: true }),
      db.subscriptions.remove({ user_id: userId }, { multi: true }),
      db.reactions.remove({ user_id: userId }, { multi: true }),
      db.reads.remove({ user_id: userId }, { multi: true }),
      db.members.remove({ user_id: userId }, { multi: true }),
      db.blocks.remove({ $or: [{ blocker_id: userId }, { blocked_id: userId }] }, { multi: true }),
    ]);

    await recordAdminAudit(req, 'gdpr_purge_user', userId, 'user', {
      deleted_username: targetUser.username,
      deleted_email: targetUser.email,
    });

    res.json({ success: true, message: `User @${targetUser.username} and all personal data permanently purged.` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/users/:id/impersonate - Visit / Log in as this user
router.post('/users/:id/impersonate', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const targetUser = await db.users.findOne({ _id: req.params.id });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const jti = uuidv4();
    const token = jwt.sign(
      { userId: targetUser._id, jti, impersonatedBy: req.userId },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    // Create session record for target user
    await db.sessions.insert({
      _id: uuidv4(),
      user_id: targetUser._id,
      token_id: jti,
      device_type: 'Desktop',
      browser: 'Admin Impersonation',
      os: 'Admin Console',
      ip_address: req.ip || '127.0.0.1',
      location: 'Admin Session',
      user_agent: req.headers['user-agent'] || 'Admin Impersonation Tool',
      is_revoked: 0,
      last_active_at: Math.floor(Date.now() / 1000),
      created_at: Math.floor(Date.now() / 1000),
    });

    await recordAdminAudit(req, 'admin_impersonate_user', targetUser._id, 'user', {
      target_username: targetUser.username,
      target_email: targetUser.email,
    });

    res.json({
      success: true,
      token,
      user: publicUser(targetUser),
      message: `Switched into account of @${targetUser.username}`,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/users/:id/set-password - Directly override and set user password
router.post('/users/:id/set-password', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const targetUser = await db.users.findOne({ _id: req.params.id });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const hash = await bcrypt.hash(new_password, 10);
    await db.users.update({ _id: targetUser._id }, { $set: { password: hash } });

    // Revoke previous sessions
    await db.sessions.update({ user_id: targetUser._id }, { $set: { is_revoked: 1 } }, { multi: true });

    await recordAdminAudit(req, 'admin_set_password', targetUser._id, 'user', {
      target_username: targetUser.username,
      target_email: targetUser.email,
    });

    res.json({
      success: true,
      message: `Password for @${targetUser.username} successfully updated to: ${new_password}`,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/admin/users/:id - Delete user account
router.delete('/users/:id', authMiddleware, requireRole('super_admin'), async (req, res) => {
  try {
    const targetUser = await db.users.findOne({ _id: req.params.id });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    if (targetUser.role === 'super_admin' && targetUser._id === req.userId) {
      return res.status(400).json({ error: 'Cannot self-delete root Super Admin' });
    }

    const userId = targetUser._id;
    await db.users.remove({ _id: userId });
    await db.messages.update(
      { sender_id: userId },
      { $set: { sender_name: 'Deleted User', content: 'Account deleted' } },
      { multi: true }
    );
    await Promise.all([
      db.stories.remove({ user_id: userId }, { multi: true }),
      db.sessions.remove({ user_id: userId }, { multi: true }),
      db.login_logs.remove({ user_id: userId }, { multi: true }),
      db.subscriptions.remove({ user_id: userId }, { multi: true }),
      db.reactions.remove({ user_id: userId }, { multi: true }),
      db.reads.remove({ user_id: userId }, { multi: true }),
      db.members.remove({ user_id: userId }, { multi: true }),
      db.blocks.remove({ $or: [{ blocker_id: userId }, { blocked_id: userId }] }, { multi: true }),
    ]);

    await recordAdminAudit(req, 'admin_delete_user', userId, 'user', {
      deleted_username: targetUser.username,
      deleted_email: targetUser.email,
    });

    res.json({ success: true, message: `Account @${targetUser.username} successfully deleted.` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.recordAdminAudit = recordAdminAudit;
