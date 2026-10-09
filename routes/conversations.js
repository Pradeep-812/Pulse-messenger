const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { decrypt } = require('../utils/crypto');

const router = express.Router();

// Helper: build conversation response object
async function buildConvResponse(conv, userId) {
  const members = await db.members.find({ conversation_id: conv._id });
  const memberIds = members.map(m => m.user_id);
  const users = await db.users.find({ _id: { $in: memberIds } });
  const userMap = {};
  users.forEach(u => userMap[u._id] = u);

  // Unread count
  const myMember = members.find(m => m.user_id === userId);
  const lastRead = myMember?.last_read_at || 0;
  const unread = await db.messages.count({
    conversation_id: conv._id,
    sender_id: { $ne: userId },
    created_at: { $gt: lastRead },
    deleted: { $ne: 1 },
  });

  // Last message
  const lastMsgs = await db.messages.find({ conversation_id: conv._id, deleted: { $ne: 1 } })
    .sort({ created_at: -1 }).limit(1);
  const lastMsg = lastMsgs[0];

  let display_name = conv.name;
  let display_avatar = conv.avatar || null;
  let other_user = null;

  if (conv.type === 'direct') {
    const otherId = memberIds.find(id => id !== userId);
    const other = userMap[otherId];
    if (other) {
      display_name = other.display_name;
      display_avatar = other.avatar || null;
      other_user = {
        id: other._id,
        display_name: other.display_name,
        username: other.username,
        bio: other.bio || '',
        phone: other.phone || '',
        status: other.status || '',
        status_emoji: other.status_emoji || '',
        name_color: other.name_color || '#7c6aff',
        avatar: other.avatar || null,
        online: other.online || 0,
        last_seen: other.last_seen || 0,
      };
    }
  } else if (conv.type === 'saved') {
    display_name = 'Saved Messages';
    display_avatar = null;
    other_user = null;
  } else if (conv.type === 'channel') {
    display_name = conv.name;
    display_avatar = conv.avatar || null;
    other_user = null;
  }

  return {
    id: conv._id,
    type: conv.type,
    name: conv.name,
    description: conv.description || '',
    handle: conv.handle || '',
    is_channel: conv.type === 'channel',
    created_by: conv.created_by,
    display_name,
    display_avatar,
    other_user,
    is_locked: conv.is_locked || false,
    is_archived: conv.is_archived || false,
    members: members.map(m => ({
      id: m.user_id,
      display_name: userMap[m.user_id]?.display_name || 'Unknown',
      role: m.role,
      online: userMap[m.user_id]?.online || 0,
    })),
    last_message: lastMsg ? decrypt(lastMsg.content) : null,
    last_message_at: lastMsg?.created_at || conv.created_at,
    updated_at: lastMsg?.created_at || conv.created_at,
    unread_count: unread,
    created_at: conv.created_at,
  };
}

// GET /api/conversations
router.get('/', authMiddleware, async (req, res) => {
  try {
    const myMemberships = await db.members.find({ user_id: req.userId });
    const convIds = myMemberships.map(m => m.conversation_id);
    const convs = await db.conversations.find({ _id: { $in: convIds } });

    const results = await Promise.all(convs.map(c => buildConvResponse(c, req.userId)));
    results.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));

    res.json({ conversations: results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/conversations/direct
router.post('/direct', authMiddleware, async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    if (user_id === req.userId) return res.status(400).json({ error: 'Cannot chat with yourself' });

    // Check if direct conv already exists
    const myMems = await db.members.find({ user_id: req.userId });
    const myConvIds = myMems.map(m => m.conversation_id);
    const theirMems = await db.members.find({ user_id, conversation_id: { $in: myConvIds } });

    for (const mem of theirMems) {
      const conv = await db.conversations.findOne({ _id: mem.conversation_id, type: 'direct' });
      if (conv) {
        const response = await buildConvResponse(conv, req.userId);
        return res.json({ conversation: response });
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const conv = await db.conversations.insert({
      _id: uuidv4(),
      type: 'direct',
      name: null,
      avatar: null,
      created_by: req.userId,
      created_at: now,
    });

    await db.members.insert([
      { _id: uuidv4(), conversation_id: conv._id, user_id: req.userId, role: 'member', joined_at: now, last_read_at: 0 },
      { _id: uuidv4(), conversation_id: conv._id, user_id, role: 'member', joined_at: now, last_read_at: 0 },
    ]);

    const response = await buildConvResponse(conv, req.userId);
    res.json({ conversation: response });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/conversations/group
router.post('/group', authMiddleware, async (req, res) => {
  try {
    const { name, member_ids } = req.body;
    if (!name) return res.status(400).json({ error: 'Group name required' });
    if (!member_ids?.length) return res.status(400).json({ error: 'Add at least one member' });

    const now = Math.floor(Date.now() / 1000);
    const conv = await db.conversations.insert({
      _id: uuidv4(),
      type: 'group',
      name,
      avatar: null,
      created_by: req.userId,
      created_at: now,
    });

    const allMemberIds = [req.userId, ...member_ids.filter(id => id !== req.userId)];
    await db.members.insert(allMemberIds.map(uid => ({
      _id: uuidv4(),
      conversation_id: conv._id,
      user_id: uid,
      role: uid === req.userId ? 'admin' : 'member',
      joined_at: now,
      last_read_at: 0,
    })));

    // System message
    const creator = await db.users.findOne({ _id: req.userId });
    await db.messages.insert({
      _id: uuidv4(),
      conversation_id: conv._id,
      sender_id: req.userId,
      sender_name: creator.display_name,
      type: 'system',
      content: `${creator.display_name} created this group`,
      created_at: now,
    });

    const response = await buildConvResponse(conv, req.userId);

    // Broadcast to all members via Socket.IO
    const io = req.app.get('io');
    if (io) {
      allMemberIds.forEach(async (uid) => {
        const userResp = await buildConvResponse(conv, uid);
        io.to(`user:${uid}`).emit('conversation:new', { conversation: userResp });
      });
    }

    res.json({ conversation: response });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST & GET /api/conversations/saved - access or create private Saved Messages self-chat
const handleSavedMessages = async (req, res) => {
  try {
    let conv = await db.conversations.findOne({ type: 'saved', created_by: req.userId });
    const now = Math.floor(Date.now() / 1000);

    if (!conv) {
      conv = await db.conversations.insert({
        _id: uuidv4(),
        type: 'saved',
        name: 'Saved Messages',
        avatar: null,
        created_by: req.userId,
        created_at: now,
      });

      await db.members.insert({
        _id: uuidv4(),
        conversation_id: conv._id,
        user_id: req.userId,
        role: 'admin',
        joined_at: now,
        last_read_at: 0,
      });

      // System greeting
      await db.messages.insert({
        _id: uuidv4(),
        conversation_id: conv._id,
        sender_id: req.userId,
        sender_name: 'Saved Messages Cloud',
        type: 'system',
        content: '🌟 Your private cloud storage space. Forward messages here, take quick notes, and store photos or files.',
        created_at: now,
      });
    }

    const response = await buildConvResponse(conv, req.userId);
    res.json({ conversation: response });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
router.post('/saved', authMiddleware, handleSavedMessages);
router.get('/saved', authMiddleware, handleSavedMessages);

// POST /api/conversations/channel - create broadcast channel
router.post('/channel', authMiddleware, async (req, res) => {
  try {
    const { name, description, handle, member_ids } = req.body;
    if (!name) return res.status(400).json({ error: 'Channel name required' });

    const now = Math.floor(Date.now() / 1000);
    const cleanHandle = handle ? handle.toLowerCase().replace(/[^a-z0-9_]/g, '') : null;

    const conv = await db.conversations.insert({
      _id: uuidv4(),
      type: 'channel',
      name: name.trim(),
      description: description ? description.trim() : '',
      handle: cleanHandle,
      avatar: null,
      created_by: req.userId,
      created_at: now,
    });

    const allMemberIds = [req.userId, ...(Array.isArray(member_ids) ? member_ids.filter(id => id !== req.userId) : [])];
    await db.members.insert(allMemberIds.map(uid => ({
      _id: uuidv4(),
      conversation_id: conv._id,
      user_id: uid,
      role: uid === req.userId ? 'admin' : 'subscriber',
      joined_at: now,
      last_read_at: 0,
    })));

    const creator = await db.users.findOne({ _id: req.userId });
    await db.messages.insert({
      _id: uuidv4(),
      conversation_id: conv._id,
      sender_id: req.userId,
      sender_name: creator.display_name,
      type: 'system',
      content: `📢 ${creator.display_name} created channel "${name}"`,
      created_at: now,
    });

    const response = await buildConvResponse(conv, req.userId);
    const io = req.app.get('io');
    if (io) {
      allMemberIds.forEach(async (uid) => {
        const userResp = await buildConvResponse(conv, uid);
        io.to(`user:${uid}`).emit('conversation:new', { conversation: userResp });
      });
    }

    res.json({ conversation: response });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/conversations/:id/members - add member to group
router.post('/:id/members', authMiddleware, async (req, res) => {
  try {
    const { user_ids } = req.body;
    if (!Array.isArray(user_ids) || !user_ids.length) {
      return res.status(400).json({ error: 'user_ids array required' });
    }

    const conv = await db.conversations.findOne({ _id: req.params.id, type: 'group' });
    if (!conv) return res.status(404).json({ error: 'Group conversation not found' });

    const myMembership = await db.members.findOne({ conversation_id: conv._id, user_id: req.userId });
    if (!myMembership) return res.status(403).json({ error: 'Not a member of this group' });

    const now = Math.floor(Date.now() / 1000);
    const actor = await db.users.findOne({ _id: req.userId });

    for (const uid of user_ids) {
      const existing = await db.members.findOne({ conversation_id: conv._id, user_id: uid });
      if (!existing) {
        await db.members.insert({
          _id: uuidv4(),
          conversation_id: conv._id,
          user_id: uid,
          role: 'member',
          joined_at: now,
          last_read_at: 0,
        });

        const targetUser = await db.users.findOne({ _id: uid });
        const targetName = targetUser?.display_name || 'A user';

        await db.messages.insert({
          _id: uuidv4(),
          conversation_id: conv._id,
          sender_id: req.userId,
          sender_name: actor.display_name,
          type: 'system',
          content: `${actor.display_name} added ${targetName}`,
          created_at: now,
        });
      }
    }

    const io = req.app.get('io');
    if (io) {
      const updatedMembers = await db.members.find({ conversation_id: conv._id });
      updatedMembers.forEach(async (m) => {
        const userResp = await buildConvResponse(conv, m.user_id);
        io.to(`user:${m.user_id}`).emit('conversation:updated', { conversation: userResp });
      });
      io.to(`conv:${conv._id}`).emit('conversation:members_changed', { conversation_id: conv._id });
    }

    const response = await buildConvResponse(conv, req.userId);
    res.json({ conversation: response });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to add members' });
  }
});

// DELETE /api/conversations/:id/members/:targetUserId - leave or remove member
router.delete('/:id/members/:targetUserId', authMiddleware, async (req, res) => {
  try {
    const conv = await db.conversations.findOne({ _id: req.params.id, type: 'group' });
    if (!conv) return res.status(404).json({ error: 'Group conversation not found' });

    const myMembership = await db.members.findOne({ conversation_id: conv._id, user_id: req.userId });
    if (!myMembership) return res.status(403).json({ error: 'Not a member of this group' });

    const targetId = req.params.targetUserId;
    if (targetId !== req.userId && myMembership.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can remove other members' });
    }

    const targetUser = await db.users.findOne({ _id: targetId });
    const actor = await db.users.findOne({ _id: req.userId });

    await db.members.remove({ conversation_id: conv._id, user_id: targetId });

    const now = Math.floor(Date.now() / 1000);
    const content = targetId === req.userId
      ? `${actor.display_name} left the group`
      : `${actor.display_name} removed ${targetUser?.display_name || 'a member'}`;

    await db.messages.insert({
      _id: uuidv4(),
      conversation_id: conv._id,
      sender_id: req.userId,
      sender_name: actor.display_name,
      type: 'system',
      content,
      created_at: now,
    });

    const io = req.app.get('io');
    if (io) {
      io.to(`conv:${conv._id}`).emit('conversation:members_changed', { conversation_id: conv._id });
      io.to(`user:${targetId}`).emit('conversation:removed', { conversation_id: conv._id });
    }

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// PATCH /api/conversations/:id - update group name or avatar
router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    const { name, avatar } = req.body;
    const conv = await db.conversations.findOne({ _id: req.params.id, type: 'group' });
    if (!conv) return res.status(404).json({ error: 'Group not found' });

    const myMembership = await db.members.findOne({ conversation_id: conv._id, user_id: req.userId });
    if (!myMembership) return res.status(403).json({ error: 'Not a member' });

    const updateObj = {};
    if (name) updateObj.name = name.trim();
    if (avatar !== undefined) updateObj.avatar = avatar;

    await db.conversations.update({ _id: conv._id }, { $set: updateObj });
    const updatedConv = await db.conversations.findOne({ _id: conv._id });

    const io = req.app.get('io');
    if (io) {
      const members = await db.members.find({ conversation_id: conv._id });
      members.forEach(async (m) => {
        const userResp = await buildConvResponse(updatedConv, m.user_id);
        io.to(`user:${m.user_id}`).emit('conversation:updated', { conversation: userResp });
      });
    }

    const response = await buildConvResponse(updatedConv, req.userId);
    res.json({ conversation: response });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to update group' });
  }
});

// GET /api/conversations/:id/members
router.get('/:id/members', authMiddleware, async (req, res) => {
  try {
    const membership = await db.members.findOne({ conversation_id: req.params.id, user_id: req.userId });
    if (!membership) return res.status(403).json({ error: 'Not a member' });

    const members = await db.members.find({ conversation_id: req.params.id });
    const userIds = members.map(m => m.user_id);
    const users = await db.users.find({ _id: { $in: userIds } });
    const userMap = {};
    users.forEach(u => userMap[u._id] = u);

    const result = members.map(m => ({
      id: m.user_id,
      display_name: userMap[m.user_id]?.display_name || 'Unknown',
      username: userMap[m.user_id]?.username || '',
      avatar: userMap[m.user_id]?.avatar || null,
      role: m.role,
      online: userMap[m.user_id]?.online || 0,
      last_seen: userMap[m.user_id]?.last_seen || 0,
    }));

    res.json({ members: result });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/conversations/:id/pinned
router.get('/:id/pinned', authMiddleware, async (req, res) => {
  try {
    const membership = await db.members.findOne({ conversation_id: req.params.id, user_id: req.userId });
    if (!membership) return res.status(403).json({ error: 'Not a member' });

    const pins = await db.pins.find({ conversation_id: req.params.id }).sort({ pinned_at: -1 });
    const msgIds = pins.map(p => p.message_id);
    const msgs = await db.messages.find({ _id: { $in: msgIds } });
    const msgMap = {};
    msgs.forEach(m => msgMap[m._id] = m);

    const pinned = pins.map(p => {
      const m = msgMap[p.message_id];
      return m ? { id: m._id, content: m.content, sender_name: m.sender_name, created_at: m.created_at } : null;
    }).filter(Boolean);

    res.json({ pinned });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/conversations/:id/lock - toggle chat lock
router.patch('/:id/lock', authMiddleware, async (req, res) => {
  try {
    const conv = await db.conversations.findOne({ _id: req.params.id });
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    const membership = await db.members.findOne({ conversation_id: conv._id, user_id: req.userId });
    if (!membership) return res.status(403).json({ error: 'Not a member' });

    const newLocked = !conv.is_locked;
    await db.conversations.update({ _id: conv._id }, { $set: { is_locked: newLocked } });
    const updated = await db.conversations.findOne({ _id: conv._id });
    const response = await buildConvResponse(updated, req.userId);

    const io = req.app.get('io');
    if (io) {
      io.to(`user:${req.userId}`).emit('conversation:updated', { conversation: response });
    }

    res.json({ conversation: response, is_locked: newLocked });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to toggle lock' });
  }
});

// PATCH /api/conversations/:id/archive - toggle chat archive
router.patch('/:id/archive', authMiddleware, async (req, res) => {
  try {
    const conv = await db.conversations.findOne({ _id: req.params.id });
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    const membership = await db.members.findOne({ conversation_id: conv._id, user_id: req.userId });
    if (!membership) return res.status(403).json({ error: 'Not a member' });

    const newArchived = !conv.is_archived;
    await db.conversations.update({ _id: conv._id }, { $set: { is_archived: newArchived } });
    const updated = await db.conversations.findOne({ _id: conv._id });
    const response = await buildConvResponse(updated, req.userId);

    const io = req.app.get('io');
    if (io) {
      io.to(`user:${req.userId}`).emit('conversation:updated', { conversation: response });
    }

    res.json({ conversation: response, is_archived: newArchived });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to toggle archive' });
  }
});

module.exports = router;
module.exports.buildConvResponse = buildConvResponse;
