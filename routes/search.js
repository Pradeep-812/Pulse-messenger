const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { decrypt } = require('../utils/crypto');

const router = express.Router();

// GET /api/search/global?q=...
router.get('/global', authMiddleware, async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    if (!q || q.length < 2) {
      return res.json({ users: [], groups: [], messages: [], media: [] });
    }

    // 1. Get user's active conversations
    const myMemberships = await db.members.find({ user_id: req.userId });
    const myConvIds = myMemberships.map(m => m.conversation_id);

    // 2. Search Users & Contacts
    const allUsers = await db.users.find({ _id: { $ne: req.userId }, banned: { $ne: 1 } });
    const matchedUsers = allUsers.filter(u =>
      (u.display_name && u.display_name.toLowerCase().includes(q)) ||
      (u.username && u.username.toLowerCase().includes(q))
    ).slice(0, 8).map(u => ({
      id: u._id,
      display_name: u.display_name,
      username: u.username,
      avatar: u.avatar,
      online: u.online,
    }));

    // 3. Search Groups
    let matchedGroups = [];
    if (myConvIds.length > 0) {
      const convs = await db.conversations.find({ _id: { $in: myConvIds }, is_group: 1 });
      matchedGroups = convs.filter(c => c.name && c.name.toLowerCase().includes(q)).slice(0, 6).map(c => ({
        id: c._id,
        name: c.name,
        avatar: c.avatar,
        is_group: true,
      }));
    }

    // 4. Search Messages in user's conversations
    let matchedMessages = [];
    let matchedMedia = [];
    if (myConvIds.length > 0) {
      const convMessages = await db.messages.find({ conversation_id: { $in: myConvIds }, deleted: { $ne: 1 } })
        .sort({ created_at: -1 })
        .limit(300);

      convMessages.forEach(m => {
        const plainText = decrypt(m.content || '');
        if (plainText && plainText.toLowerCase().includes(q)) {
          if (matchedMessages.length < 15) {
            matchedMessages.push({
              id: m._id,
              conversation_id: m.conversation_id,
              sender_name: m.sender_name,
              content: plainText,
              type: m.type,
              created_at: m.created_at,
            });
          }
        }

        // Shared media files matching
        if (m.file_url) {
          const fn = (m.file_name || '').toLowerCase();
          if (fn.includes(q) || (m.type && m.type.includes(q))) {
            if (matchedMedia.length < 10) {
              matchedMedia.push({
                id: m._id,
                conversation_id: m.conversation_id,
                file_url: m.file_url,
                file_name: m.file_name,
                file_size: m.file_size,
                type: m.type,
                created_at: m.created_at,
              });
            }
          }
        }
      });
    }

    res.json({
      query: q,
      users: matchedUsers,
      groups: matchedGroups,
      messages: matchedMessages,
      media: matchedMedia,
    });
  } catch (e) {
    console.error('[search:global]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/search/star-message/:msgId - Toggle starred/bookmarked message
router.post('/star-message/:msgId', authMiddleware, async (req, res) => {
  try {
    const msgId = req.params.msgId;
    const existing = await db.starred_messages.findOne({ user_id: req.userId, message_id: msgId });

    if (existing) {
      await db.starred_messages.remove({ _id: existing._id });
      res.json({ starred: false, message: 'Message unstarred' });
    } else {
      const msg = await db.messages.findOne({ _id: msgId });
      if (!msg) return res.status(404).json({ error: 'Message not found' });

      await db.starred_messages.insert({
        _id: uuidv4(),
        user_id: req.userId,
        message_id: msgId,
        conversation_id: msg.conversation_id,
        created_at: Math.floor(Date.now() / 1000),
      });
      res.json({ starred: true, message: 'Message added to Starred Messages' });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/search/starred-messages - View user's starred messages
router.get('/starred-messages', authMiddleware, async (req, res) => {
  try {
    const stars = await db.starred_messages.find({ user_id: req.userId }).sort({ created_at: -1 });
    const msgIds = stars.map(s => s.message_id);

    const msgs = await db.messages.find({ _id: { $in: msgIds } });
    const formatted = msgs.map(m => ({
      id: m._id,
      conversation_id: m.conversation_id,
      sender_name: m.sender_name,
      content: decrypt(m.content || ''),
      type: m.type,
      file_url: m.file_url,
      file_name: m.file_name,
      created_at: m.created_at,
    }));

    res.json({ starred_messages: formatted });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
