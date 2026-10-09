const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'pulse_secret_change_in_prod';

// Role permissions dictionary
const ROLE_PERMISSIONS = {
  super_admin: ['*'],
  content_moderator: [
    'view_dashboard',
    'view_reports',
    'action_reports',
    'delete_messages',
    'delete_stories',
    'warn_users',
    'view_audit',
    'manage_filters',
    'ban_users',
  ],
  support_staff: [
    'view_dashboard',
    'view_users',
    'view_sessions',
    'force_logout',
    'generate_recovery',
    'view_logs',
  ],
  user: [],
};

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized: No token provided' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const userId = payload.sub;
    const tokenId = payload.jti || null;

    // Check if session has been revoked
    if (tokenId) {
      const session = await db.sessions.findOne({ token_id: tokenId });
      if (session && session.is_revoked) {
        return res.status(401).json({ error: 'Session has been revoked or logged out remotely' });
      }
      // Update session last_active_at asynchronously
      if (session) {
        db.sessions.update({ _id: session._id }, { $set: { last_active_at: Math.floor(Date.now() / 1000) } }).catch(() => {});
      }
    }

    const user = await db.users.findOne({ _id: userId });
    if (!user) return res.status(401).json({ error: 'User not found' });

    // Check if user is banned
    if (user.banned) {
      return res.status(403).json({
        error: `Account suspended. Reason: ${user.ban_reason || 'Terms of service violation'}. Contact support for review.`,
        banned: true,
      });
    }

    req.userId = userId;
    req.tokenId = tokenId;
    req.user = user;
    req.userRole = user.role || 'user';
    req.userPermissions = user.permissions || ROLE_PERMISSIONS[req.userRole] || [];

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const userRole = req.userRole || 'user';
    if (userRole === 'super_admin' || roles.includes(userRole)) {
      return next();
    }
    return res.status(403).json({
      error: `Access denied. Requires one of roles: [${roles.join(', ')}]`,
    });
  };
}

function requirePermission(perm) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const perms = req.userPermissions || [];
    if (perms.includes('*') || perms.includes(perm)) {
      return next();
    }
    return res.status(403).json({
      error: `Access denied. Lacks required permission: '${perm}'`,
    });
  };
}

async function socketAuth(socket, next) {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Unauthorized'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const userId = payload.sub;
    const tokenId = payload.jti || null;

    if (tokenId) {
      const session = await db.sessions.findOne({ token_id: tokenId });
      if (session && session.is_revoked) {
        return next(new Error('Session revoked'));
      }
    }

    const user = await db.users.findOne({ _id: userId });
    if (!user) return next(new Error('User not found'));
    if (user.banned) return next(new Error('Account suspended'));

    socket.userId = user._id;
    socket.tokenId = tokenId;
    socket.user = user;
    socket.userRole = user.role || 'user';
    next();
  } catch {
    next(new Error('Invalid token'));
  }
}

module.exports = {
  authMiddleware,
  socketAuth,
  requireRole,
  requirePermission,
  ROLE_PERMISSIONS,
  JWT_SECRET,
};
