const express = require('express');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { encrypt, decrypt } = require('../utils/crypto');

const router = express.Router();
const BACKUP_DIR = path.join(__dirname, '../backups');
const DATA_DIR = path.join(__dirname, '../data');

if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

/**
 * Helper to create a complete database snapshot file
 */
async function createDatabaseSnapshot(prefix = 'pulse_backup') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${prefix}_${timestamp}.json.gz`;
  const filePath = path.join(BACKUP_DIR, filename);

  const [users, conversations, members, messages, reactions, pins, reads, blocks] = await Promise.all([
    db.users.find({}),
    db.conversations.find({}),
    db.members.find({}),
    db.messages.find({}),
    db.reactions.find({}),
    db.pins.find({}),
    db.reads.find({}),
    db.blocks.find({}),
  ]);

  // Strip hashed passwords for privacy/safety
  const safeUsers = users.map(u => ({ ...u, password: '[REDACTED]' }));

  const dump = {
    version: '1.0.0',
    createdAt: new Date().toISOString(),
    stats: {
      users: safeUsers.length,
      conversations: conversations.length,
      messages: messages.length,
    },
    data: {
      users: safeUsers,
      conversations,
      members,
      messages,
      reactions,
      pins,
      reads,
      blocks,
    },
  };

  const jsonStr = JSON.stringify(dump, null, 2);
  const compressed = zlib.gzipSync(Buffer.from(jsonStr, 'utf8'));
  fs.writeFileSync(filePath, compressed);

  return {
    filename,
    filePath,
    sizeBytes: compressed.length,
    createdAt: dump.createdAt,
    stats: dump.stats,
  };
}

// GET /api/backup/export?type=json|txt&convId=...
router.get('/export', authMiddleware, async (req, res) => {
  try {
    const type = (req.query.type || 'json').toLowerCase();
    const convId = req.query.convId;

    if (type === 'txt') {
      if (!convId) {
        return res.status(400).json({ error: 'convId is required for TXT export' });
      }

      const membership = await db.members.findOne({ conversation_id: convId, user_id: req.userId });
      if (!membership) return res.status(403).json({ error: 'Not a member of this chat' });

      const conv = await db.conversations.findOne({ _id: convId });
      const msgs = await db.messages.find({ conversation_id: convId }).sort({ created_at: 1 });

      let txt = `========================================================\n`;
      txt += `PULSE MESSENGER CHAT EXPORT\n`;
      txt += `Conversation: ${conv?.name || 'Direct Chat'}\n`;
      txt += `Exported At: ${new Date().toLocaleString()}\n`;
      txt += `Total Messages: ${msgs.length}\n`;
      txt += `========================================================\n\n`;

      msgs.forEach(m => {
        const time = new Date(m.created_at * 1000).toLocaleString();
        const content = decrypt(m.content);
        txt += `[${time}] ${m.sender_name}:\n${content}\n`;
        if (m.file_url) txt += `  [Attachment: ${m.file_name || m.file_url}]\n`;
        txt += `\n`;
      });

      const safeName = (conv?.name || 'chat').replace(/[^a-zA-Z0-9_-]/g, '_');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="pulse_chat_${safeName}_${Date.now()}.txt"`);
      return res.send(txt);
    }

    // Default: JSON export of all chats user is part of
    const myMemberships = await db.members.find({ user_id: req.userId });
    const convIds = myMemberships.map(m => m.conversation_id);

    const [userConvs, userMsgs, userReactions] = await Promise.all([
      db.conversations.find({ _id: { $in: convIds } }),
      db.messages.find({ conversation_id: { $in: convIds } }),
      db.reactions.find({}),
    ]);

    const decryptedMsgs = userMsgs.map(m => ({
      ...m,
      content: decrypt(m.content),
      reply_content: m.reply_content ? decrypt(m.reply_content) : null,
    }));

    const exportData = {
      app: 'Pulse Messenger',
      exportedBy: req.userId,
      exportedAt: new Date().toISOString(),
      conversations: userConvs,
      messages: decryptedMsgs,
      reactions: userReactions.filter(r => convIds.some(cid => userMsgs.some(m => m._id === r.message_id))),
    };

    const filename = `pulse_backup_${Date.now()}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(exportData, null, 2));
  } catch (err) {
    console.error('[backup:export]', err);
    res.status(500).json({ error: 'Failed to export backup: ' + err.message });
  }
});

// POST /api/backup/import (Restore / Import chats)
router.post('/import', authMiddleware, async (req, res) => {
  try {
    let backupData = req.body;
    if (typeof backupData === 'string') {
      backupData = JSON.parse(backupData);
    }
    if (backupData.backupData) {
      backupData = typeof backupData.backupData === 'string'
        ? JSON.parse(backupData.backupData)
        : backupData.backupData;
    }

    if (!backupData || (!backupData.conversations && !backupData.messages)) {
      return res.status(400).json({ error: 'Invalid backup file format' });
    }

    const convs = Array.isArray(backupData.conversations) ? backupData.conversations : [];
    const msgs = Array.isArray(backupData.messages) ? backupData.messages : [];

    let restoredConvs = 0;
    let restoredMsgs = 0;

    // Restore conversations & memberships
    for (const c of convs) {
      const existing = await db.conversations.findOne({ _id: c._id });
      if (!existing) {
        await db.conversations.insert(c);
        restoredConvs++;
      }
      // Ensure current user is a member
      const memberExists = await db.members.findOne({ conversation_id: c._id, user_id: req.userId });
      if (!memberExists) {
        await db.members.insert({
          _id: uuidv4(),
          conversation_id: c._id,
          user_id: req.userId,
          role: 'member',
          last_read_at: Math.floor(Date.now() / 1000),
        });
      }
    }

    // Restore messages
    for (const m of msgs) {
      const existing = await db.messages.findOne({ _id: m._id });
      if (!existing) {
        // Re-encrypt content for secure storage in database
        const encryptedContent = encrypt(m.content || '');
        const encryptedReply = m.reply_content ? encrypt(m.reply_content) : null;
        await db.messages.insert({
          ...m,
          content: encryptedContent,
          reply_content: encryptedReply,
          is_encrypted: 1,
        });
        restoredMsgs++;
      }
    }

    res.json({
      success: true,
      restoredConversations: restoredConvs,
      restoredMessages: restoredMsgs,
      totalConversations: convs.length,
      totalMessages: msgs.length,
    });
  } catch (err) {
    console.error('[backup:import]', err);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

// POST /api/backup/snapshot (Trigger server database snapshot)
router.post('/snapshot', authMiddleware, async (req, res) => {
  try {
    const snapshot = await createDatabaseSnapshot('pulse_manual_backup');
    res.json({ success: true, snapshot });
  } catch (err) {
    console.error('[backup:snapshot]', err);
    res.status(500).json({ error: 'Snapshot failed: ' + err.message });
  }
});

// GET /api/backup/list (List all server database snapshots)
router.get('/list', authMiddleware, async (req, res) => {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      return res.json({ backups: [] });
    }

    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json.gz') || f.endsWith('.json') || f.endsWith('.db'));
    const backups = files.map(filename => {
      const stat = fs.statSync(path.join(BACKUP_DIR, filename));
      return {
        filename,
        sizeBytes: stat.size,
        createdAt: stat.birthtime || stat.mtime,
      };
    }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ backups });
  } catch (err) {
    console.error('[backup:list]', err);
    res.status(500).json({ error: 'Failed to list backups' });
  }
});

// GET /api/backup/download/:filename
router.get('/download/:filename', authMiddleware, (req, res) => {
  try {
    const safeFilename = path.basename(req.params.filename);
    const filePath = path.join(BACKUP_DIR, safeFilename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Backup not found' });
    }
    res.download(filePath, safeFilename);
  } catch (err) {
    res.status(500).json({ error: 'Download failed: ' + err.message });
  }
});

module.exports = router;
module.exports.createDatabaseSnapshot = createDatabaseSnapshot;
