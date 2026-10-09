const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

function publicUser(u) {
  return {
    id: u._id,
    display_name: u.display_name,
    username: u.username,
    phone: u.phone || '',
    bio: u.bio || '',
    status: u.status || '',
    status_emoji: u.status_emoji || '',
    name_color: u.name_color || '#7c6aff',
    custom_badge: u.custom_badge || '',
    avatar: u.avatar || null,
    online: u.online || 0,
    last_seen: u.last_seen || 0,
  };
}

// GET /api/users/contacts - searchable list of saved contacts with real-time online/offline
router.get('/contacts', authMiddleware, async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase().trim();

    // 1. Fetch explicitly saved contacts
    const savedContacts = await db.contacts.find({ user_id: req.userId });
    const savedContactUserIds = savedContacts.map(c => c.contact_user_id);

    // 2. Also fetch users from user's direct conversations
    const myMems = await db.members.find({ user_id: req.userId });
    const myConvIds = myMems.map(m => m.conversation_id);
    const directConvs = await db.conversations.find({ _id: { $in: myConvIds }, type: 'direct' });
    const directConvIds = directConvs.map(c => c._id);
    const otherMems = await db.members.find({ conversation_id: { $in: directConvIds }, user_id: { $ne: req.userId } });
    const convUserIds = otherMems.map(m => m.user_id);

    const allContactIds = [...new Set([...savedContactUserIds, ...convUserIds])];

    // Fetch user documents
    let users = await db.users.find({ _id: { $in: allContactIds } });

    // Filter out blocked users
    const blocks = await db.blocks.find({
      $or: [{ blocker_id: req.userId }, { blocked_id: req.userId }]
    });
    const blockedIds = new Set(blocks.flatMap(b => [b.blocker_id, b.blocked_id]));
    users = users.filter(u => !blockedIds.has(u._id));

    if (q) {
      users = users.filter(u =>
        u.display_name?.toLowerCase().includes(q) ||
        u.username?.toLowerCase().includes(q) ||
        u.phone?.toLowerCase().includes(q)
      );
    }

    // Sort: online first, then alphabetical by display_name
    users.sort((a, b) => {
      if ((b.online || 0) !== (a.online || 0)) return (b.online || 0) - (a.online || 0);
      return (a.display_name || '').localeCompare(b.display_name || '');
    });

    res.json({ contacts: users.map(publicUser) });
  } catch (e) {
    console.error('[users:contacts]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/users/contacts - add user to contacts
router.post('/contacts', authMiddleware, async (req, res) => {
  try {
    const { contact_user_id, username, phone } = req.body;
    let targetUser = null;

    if (contact_user_id) {
      targetUser = await db.users.findOne({ _id: contact_user_id });
    } else if (username) {
      targetUser = await db.users.findOne({ username: username.toLowerCase().trim().replace(/^@/, '') });
    } else if (phone) {
      targetUser = await db.users.findOne({ phone: phone.trim() });
    }

    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (targetUser._id === req.userId) {
      return res.status(400).json({ error: 'Cannot add yourself to contacts' });
    }

    const existing = await db.contacts.findOne({ user_id: req.userId, contact_user_id: targetUser._id });
    if (!existing) {
      await db.contacts.insert({
        _id: uuidv4(),
        user_id: req.userId,
        contact_user_id: targetUser._id,
        created_at: Math.floor(Date.now() / 1000),
      });
    }

    res.json({ success: true, contact: publicUser(targetUser) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/users/contacts/:contactUserId - remove contact
router.delete('/contacts/:contactUserId', authMiddleware, async (req, res) => {
  try {
    await db.contacts.remove({ user_id: req.userId, contact_user_id: req.params.contactUserId });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/users/search?q=...
router.get('/search', authMiddleware, async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase().trim().replace(/^@/, '');
    if (q.length < 2) return res.json({ users: [] });

    // Get blocked user IDs in both directions
    const blocks = await db.blocks.find({
      $or: [{ blocker_id: req.userId }, { blocked_id: req.userId }]
    });
    const blockedIds = new Set(blocks.flatMap(b => [b.blocker_id, b.blocked_id]));
    blockedIds.delete(req.userId); // Don't exclude ourselves from blocked set

    const allUsers = await db.users.find({
      _id: { $ne: req.userId }
    });

    const results = allUsers.filter(u => {
      if (blockedIds.has(u._id)) return false;
      return (
        u.display_name?.toLowerCase().includes(q) ||
        u.username?.toLowerCase().includes(q) ||
        (u.phone && u.phone.includes(q))
      );
    }).slice(0, 15).map(publicUser);

    res.json({ users: results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/users/block
router.post('/block', authMiddleware, async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    const existing = await db.blocks.findOne({ blocker_id: req.userId, blocked_id: user_id });
    if (!existing) {
      await db.blocks.insert({
        _id: uuidv4(),
        blocker_id: req.userId,
        blocked_id: user_id,
        created_at: Math.floor(Date.now() / 1000),
      });
    }
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/users/block/:userId
router.delete('/block/:userId', authMiddleware, async (req, res) => {
  try {
    await db.blocks.remove({ blocker_id: req.userId, blocked_id: req.params.userId });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.publicUser = publicUser;
