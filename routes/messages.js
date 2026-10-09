const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { encrypt, decrypt, isEncrypted } = require('../utils/crypto');

const router = express.Router();

async function enrichMessages(messages, userId) {
  const msgIds = messages.map(m => m._id);

  const [reactions, reads] = await Promise.all([
    db.reactions.find({ message_id: { $in: msgIds } }),
    db.reads.find({ message_id: { $in: msgIds } }),
  ]);

  const reactionMap = {};
  reactions.forEach(r => {
    if (!reactionMap[r.message_id]) reactionMap[r.message_id] = [];
    reactionMap[r.message_id].push({ emoji: r.emoji, user_id: r.user_id });
  });

  const readMap = {};
  reads.forEach(r => {
    if (!readMap[r.message_id]) readMap[r.message_id] = [];
    readMap[r.message_id].push({ user_id: r.user_id });
  });

  return messages.map(m => {
    const rawContent = m.content || '';
    const decryptedContent = decrypt(rawContent);
    const decryptedReply = m.reply_content ? decrypt(m.reply_content) : null;

    return {
      id: m._id,
      conversation_id: m.conversation_id,
      sender_id: m.sender_id,
      sender_name: m.sender_name,
      content: decryptedContent,
      is_encrypted: isEncrypted(rawContent) || !!m.is_encrypted,
      type: m.type || 'text',
      file_url: m.file_url || null,
      file_name: m.file_name || null,
      file_size: m.file_size || null,
      call_type: m.call_type || null,
      call_status: m.call_status || null,
      call_duration: m.call_duration || 0,
      reply_to: m.reply_to || null,
      reply_content: decryptedReply,
      reply_sender_name: m.reply_sender_name || null,
      edited: m.edited || 0,
      deleted: m.deleted || 0,
      created_at: m.created_at,
      reactions: reactionMap[m._id] || [],
      read_by: readMap[m._id] || [],
    };
  });
}

// GET /api/messages?conversation_id=...&limit=60
router.get('/', authMiddleware, async (req, res) => {
  try {
    const convId = req.query.conversation_id;
    if (!convId) {
      return res.status(400).json({ error: 'conversation_id query parameter is required' });
    }

    const membership = await db.members.findOne({ conversation_id: convId, user_id: req.userId });
    if (!membership) return res.status(403).json({ error: 'Not a member' });

    const limit = Math.min(parseInt(req.query.limit) || 60, 100);
    const before = parseInt(req.query.before) || null;

    let query = { conversation_id: convId };
    if (before) query.created_at = { $lt: before };

    const messages = await db.messages.find(query).sort({ created_at: -1 }).limit(limit);
    messages.reverse();

    const enriched = await enrichMessages(messages, req.userId);
    res.json({ messages: enriched });
  } catch (e) {
    console.error('[messages:get]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/messages/:convId?limit=60&before=<timestamp>
router.get('/:convId', authMiddleware, async (req, res) => {
  try {
    const { convId } = req.params;

    // Verify membership
    const membership = await db.members.findOne({ conversation_id: convId, user_id: req.userId });
    if (!membership) return res.status(403).json({ error: 'Not a member' });

    const limit = Math.min(parseInt(req.query.limit) || 60, 100);
    const before = parseInt(req.query.before) || null;

    let query = { conversation_id: convId };
    if (before) query.created_at = { $lt: before };

    const messages = await db.messages.find(query).sort({ created_at: -1 }).limit(limit);
    messages.reverse();

    const enriched = await enrichMessages(messages, req.userId);
    res.json({ messages: enriched });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/messages (REST message creation with DB persistence & encryption)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { conversation_id, content, type = 'text', reply_to, file_url, file_name, file_size } = req.body;
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id required' });
    if (!content && !file_url) return res.status(400).json({ error: 'Empty message' });

    const membership = await db.members.findOne({ conversation_id, user_id: req.userId });
    if (!membership) return res.status(403).json({ error: 'Not a member' });

    const user = await db.users.findOne({ _id: req.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const now = Math.floor(Date.now() / 1000);

    let reply_content = null;
    let reply_sender_name = null;
    if (reply_to) {
      const replyMsg = await db.messages.findOne({ _id: reply_to });
      if (replyMsg) {
        reply_content = replyMsg.content ? decrypt(replyMsg.content) : '';
        reply_sender_name = replyMsg.sender_name;
      }
    }

    // Encrypt message content before saving into database
    const encryptedContent = content ? encrypt(content) : '';

    const newMsg = await db.messages.insert({
      _id: uuidv4(),
      conversation_id,
      sender_id: req.userId,
      sender_name: user.display_name,
      content: encryptedContent,
      is_encrypted: 1,
      type,
      file_url: file_url || null,
      file_name: file_name || null,
      file_size: file_size || null,
      reply_to: reply_to || null,
      reply_content: reply_content ? encrypt(reply_content) : null,
      reply_sender_name,
      edited: 0,
      deleted: 0,
      created_at: now,
    });

    const [enriched] = await enrichMessages([newMsg], req.userId);

    // Broadcast via io if app has socket server attached
    const io = req.app.get('io');
    if (io) {
      io.to(`conv:${conversation_id}`).emit('message:new', {
        conversation_id,
        message: enriched,
      });
    }

    // Check if message mentions @ai
    if (content && content.trim().startsWith('@ai')) {
      const { generateAiChatResponse } = require('./ai');
      const aiPrompt = content.replace(/^@ai\s*/i, '').trim();

      // Trigger asynchronous AI answer
      setTimeout(async () => {
        try {
          if (io) {
            io.to(`conv:${conversation_id}`).emit('typing:start', {
              conversation_id,
              user_id: 'ai-assistant',
              display_name: '⚡ Pulse AI',
            });
          }

          const aiReply = await generateAiChatResponse(aiPrompt, conversation_id, req.userId);
          const aiMsg = await db.messages.insert({
            _id: uuidv4(),
            conversation_id,
            sender_id: 'ai-assistant',
            sender_name: '⚡ Pulse AI',
            content: encrypt(aiReply),
            is_encrypted: 1,
            type: 'ai',
            file_url: null,
            file_name: null,
            file_size: null,
            reply_to: newMsg._id,
            reply_content: encrypt(content),
            reply_sender_name: user.display_name,
            edited: 0,
            deleted: 0,
            created_at: Math.floor(Date.now() / 1000),
          });

          if (io) {
            io.to(`conv:${conversation_id}`).emit('typing:stop', {
              conversation_id,
              user_id: 'ai-assistant',
            });
            const [enrichedAi] = await enrichMessages([aiMsg], req.userId);
            io.to(`conv:${conversation_id}`).emit('message:new', {
              conversation_id,
              message: enrichedAi,
            });
          }
        } catch (err) {
          console.error('[messages:aiResponse] error:', err);
        }
      }, 300);
    }

    res.status(201).json({ success: true, message: enriched });
  } catch (e) {
    console.error('[messages:post]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/messages/calls/history - get call log history
router.get('/calls/history', authMiddleware, async (req, res) => {
  try {
    const myMems = await db.members.find({ user_id: req.userId });
    const convIds = myMems.map(m => m.conversation_id);
    if (!convIds.length) return res.json({ calls: [] });

    const callMsgs = await db.messages.find({
      conversation_id: { $in: convIds },
      type: 'call'
    }).sort({ created_at: -1 }).limit(60);

    // Load conv details and users
    const convs = await db.conversations.find({ _id: { $in: [...new Set(callMsgs.map(c => c.conversation_id))] } });
    const convMap = {};
    convs.forEach(c => convMap[c._id] = c);

    const allMembers = await db.members.find({ conversation_id: { $in: convIds } });
    const userIds = [...new Set(allMembers.map(m => m.user_id))];
    const users = await db.users.find({ _id: { $in: userIds } });
    const userMap = {};
    users.forEach(u => userMap[u._id] = u);

    const results = callMsgs.map(c => {
      const isOutgoing = c.sender_id === req.userId;
      const membersInConv = allMembers.filter(m => m.conversation_id === c.conversation_id && m.user_id !== req.userId);
      const otherUserId = isOutgoing ? (membersInConv[0]?.user_id || c.sender_id) : c.sender_id;
      const otherUser = userMap[otherUserId] || { display_name: c.sender_name || 'Contact', _id: otherUserId };

      let callDirection = isOutgoing ? 'outgoing' : 'incoming';
      if (c.call_status === 'missed' || c.call_status === 'cancelled') {
        if (!isOutgoing) callDirection = 'missed';
      }

      return {
        id: c._id,
        conversation_id: c.conversation_id,
        call_type: c.call_type || 'voice', // voice | video
        call_status: c.call_status || 'completed', // completed | missed | declined | cancelled | busy
        direction: callDirection, // outgoing | incoming | missed
        duration: c.call_duration || 0,
        created_at: c.created_at,
        caller_name: c.sender_name,
        target_user: {
          id: otherUser._id,
          display_name: otherUser.display_name || c.sender_name,
          username: otherUser.username || '',
          avatar: otherUser.avatar || null,
          online: otherUser.online || 0,
        }
      };
    });

    res.json({ calls: results });
  } catch (e) {
    console.error('[messages:calls:history]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.enrichMessages = enrichMessages;
