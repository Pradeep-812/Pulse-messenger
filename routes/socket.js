const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { enrichMessages } = require('../routes/messages');
const { encrypt, decrypt } = require('../utils/crypto');
const { generateAiChatResponse } = require('../routes/ai');
const { checkContentSpam } = require('../services/contentModerationFilter');

// Track online users: userId -> Set of socketIds
const onlineUsers = new Map();

// Track in-progress calls: call_id -> { callId, callerId, callerName, calleeId, calleeName,
//   conversationId, callType, status ('ringing'|'active'), startedAt, connectedAt }
const activeCalls = new Map();

function getSocketsForUser(io, userId) {
  const socketIds = onlineUsers.get(userId);
  if (!socketIds) return [];
  return [...socketIds].map(id => io.sockets.sockets.get(id)).filter(Boolean);
}

async function getMemberIds(convId) {
  const members = await db.members.find({ conversation_id: convId });
  return members.map(m => m.user_id);
}

// Any call (ringing or active) this user is currently part of
function findActiveCallForUser(userId) {
  for (const call of activeCalls.values()) {
    if (call.callerId === userId || call.calleeId === userId) return call;
  }
  return null;
}

// Write a "call log" message into the conversation (missed/declined/completed/cancelled)
// so both participants see a record of the call in their chat history, WhatsApp-style.
async function logCallMessage(io, call, status) {
  try {
    const duration = call.connectedAt ? Math.max(0, Math.floor((Date.now() - call.connectedAt) / 1000)) : 0;
    const icon = call.callType === 'video' ? '📹' : '📞';
    const labels = {
      completed: `${icon} ${call.callType === 'video' ? 'Video' : 'Voice'} call · ${formatDuration(duration)}`,
      missed: `${icon} Missed ${call.callType === 'video' ? 'video' : 'voice'} call`,
      declined: `${icon} ${call.callType === 'video' ? 'Video' : 'Voice'} call declined`,
      cancelled: `${icon} ${call.callType === 'video' ? 'Video' : 'Voice'} call cancelled`,
      busy: `${icon} ${call.callType === 'video' ? 'Video' : 'Voice'} call · user busy`,
    };

    const now = Math.floor(Date.now() / 1000);
    const msg = await db.messages.insert({
      _id: uuidv4(),
      conversation_id: call.conversationId,
      sender_id: call.callerId,
      sender_name: call.callerName,
      content: labels[status] || `${icon} Call ended`,
      type: 'call',
      call_type: call.callType,
      call_status: status,
      call_duration: duration,
      file_url: null,
      file_name: null,
      file_size: null,
      reply_to: null,
      reply_content: null,
      reply_sender_name: null,
      edited: 0,
      deleted: 0,
      created_at: now,
    });

    const [enriched] = await enrichMessages([msg], call.callerId);
    io.to(`conv:${call.conversationId}`).emit('message:new', { conversation_id: call.conversationId, message: enriched });
  } catch (e) {
    console.error('[logCallMessage]', e);
  }
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function setupSocket(io) {
  io.on('connection', async (socket) => {
    const userId = socket.userId;
    const user = socket.user;

    // Track online
    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);
    socket.join(`user:${userId}`);

    // Mark user online
    await db.users.update({ _id: userId }, { $set: { online: 1 } });

    // Notify contacts of presence
    const myMems = await db.members.find({ user_id: userId });
    const convIds = myMems.map(m => m.conversation_id);
    if (convIds.length) {
      const allMems = await db.members.find({ conversation_id: { $in: convIds }, user_id: { $ne: userId } });
      const contactIds = [...new Set(allMems.map(m => m.user_id))];
      for (const contactId of contactIds) {
        for (const sock of getSocketsForUser(io, contactId)) {
          sock.emit('user:presence', { user_id: userId, online: true });
        }
      }
    }

    console.log(`[socket] ${user.display_name} connected (${socket.id})`);

    // ─── JOIN CONVERSATION ROOM ───────────────────────────────────
    socket.on('conversation:join', async ({ conversation_id }) => {
      const membership = await db.members.findOne({ conversation_id, user_id: userId });
      if (!membership) return;
      socket.join(`conv:${conversation_id}`);
    });

    // ─── AUTO-JOIN all user's conversations on connect ────────────
    // So they receive messages even without clicking a conversation
    if (convIds.length) {
      for (const cid of convIds) socket.join(`conv:${cid}`);
    }

    // ─── SEND MESSAGE ─────────────────────────────────────────────
    socket.on('message:send', async (data, ack) => {
      try {
        const { conversation_id, content, type = 'text', reply_to, file_url, file_name, file_size } = data;

        const membership = await db.members.findOne({ conversation_id, user_id: userId });
        if (!membership) return ack?.({ error: 'Not a member' });
        if (!content && !file_url) return ack?.({ error: 'Empty message' });

        // Check if recipient has blocked sender
        const otherMembers = await db.members.find({ conversation_id, user_id: { $ne: userId } });
        const otherUserIds = otherMembers.map(m => m.user_id);
        if (otherUserIds.length > 0) {
          const isBlocked = await db.blocks.findOne({ blocker_id: { $in: otherUserIds }, blocked_id: userId });
          if (isBlocked) {
            return ack?.({ error: 'Message not delivered: You have been blocked by this contact' });
          }
        }

        const now = Math.floor(Date.now() / 1000);

        // Disappearing messages expiration calculation & channel check
        const conv = await db.conversations.findOne({ _id: conversation_id });
        if (conv && conv.type === 'channel') {
          const isCreator = conv.created_by === userId;
          const isAdmin = membership.role === 'admin';
          if (!isCreator && !isAdmin) {
            return ack?.({ error: 'Broadcast channel: Only admins can post announcements' });
          }
        }
        const expiresAt = (conv && conv.disappearing_timer > 0) ? (now + conv.disappearing_timer) : null;

        let reply_content = null, reply_sender_name = null;
        if (reply_to) {
          const replyMsg = await db.messages.findOne({ _id: reply_to });
          if (replyMsg) {
            reply_content = replyMsg.content ? decrypt(replyMsg.content) : '';
            reply_sender_name = replyMsg.sender_name;
          }
        }

        // Encrypt message content in database
        const encryptedContent = content ? encrypt(content) : '';
        const msgId = uuidv4();

        // Automated keyword and spam moderation check
        const spamCheck = await checkContentSpam(content, userId, 'message', msgId);

        const msg = await db.messages.insert({
          _id: msgId,
          conversation_id,
          sender_id: userId,
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
          is_flagged: spamCheck.isFlagged ? 1 : 0,
          expires_at: expiresAt,
          created_at: now,
        });

        const [enriched] = await enrichMessages([msg], userId);

        // Broadcast to entire room
        io.to(`conv:${conversation_id}`).emit('message:new', { conversation_id, message: enriched });

        // Delivery receipt: check if any recipient is currently connected
        const anyRecipientOnline = otherUserIds.some(uid => onlineUsers.has(uid) && onlineUsers.get(uid).size > 0);
        if (anyRecipientOnline) {
          socket.emit('message:delivered', {
            conversation_id,
            message_id: msgId,
            delivered_at: now,
          });
        }

        // Dispatch web push notifications to other members
        (async () => {
          try {
            const allMembers = await db.members.find({ conversation_id, user_id: { $ne: userId } });
            const targetUserIds = allMembers.map(m => m.user_id);
            if (targetUserIds.length) {
              const pushService = require('../services/pushService');
              const preview = type === 'image' ? '📷 Photo' : (type === 'voice' || type === 'audio' ? '🎤 Voice message' : (type === 'video' ? '🎥 Video' : (content ? content.substring(0, 100) : 'New message')));
              pushService.sendPushToUsers(targetUserIds, {
                title: user.display_name,
                body: preview,
                icon: user.avatar || '/icons/icon-192.png',
                badge: '/icons/icon-192.png',
                data: {
                  url: `/#chat=${conversation_id}`,
                  conversation_id,
                  sender_id: userId,
                }
              }).catch(() => {});
            }
          } catch (pe) {
            // Push notification best effort
          }
        })();

        ack?.({ success: true, message: enriched });

        // Handle @ai instant response shortcut inside chat
        if (content && content.trim().startsWith('@ai')) {
          const aiPrompt = content.replace(/^@ai\s*/i, '').trim();
          setTimeout(async () => {
            try {
              io.to(`conv:${conversation_id}`).emit('typing:start', {
                conversation_id,
                user_id: 'ai-assistant',
                display_name: '⚡ Pulse AI',
              });

              const aiReply = await generateAiChatResponse(aiPrompt, conversation_id, userId);

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
                reply_to: msg._id,
                reply_content: encrypt(content),
                reply_sender_name: user.display_name,
                edited: 0,
                deleted: 0,
                created_at: Math.floor(Date.now() / 1000),
              });

              io.to(`conv:${conversation_id}`).emit('typing:stop', {
                conversation_id,
                user_id: 'ai-assistant',
              });

              const [enrichedAi] = await enrichMessages([aiMsg], userId);
              io.to(`conv:${conversation_id}`).emit('message:new', {
                conversation_id,
                message: enrichedAi,
              });
            } catch (err) {
              console.error('[socket:@ai] error:', err);
            }
          }, 400);
        }
      } catch (e) {
        console.error('[message:send]', e);
        ack?.({ error: 'Failed to send' });
      }
    });

    // ─── EDIT MESSAGE ─────────────────────────────────────────────
    socket.on('message:edit', async ({ message_id, content }) => {
      try {
        const msg = await db.messages.findOne({ _id: message_id, sender_id: userId });
        if (!msg || msg.deleted) return;
        const encryptedContent = encrypt(content);
        await db.messages.update({ _id: message_id }, { $set: { content: encryptedContent, edited: 1 } });
        const updated = { ...msg, content: encryptedContent, edited: 1 };
        const [enriched] = await enrichMessages([updated], userId);
        io.to(`conv:${msg.conversation_id}`).emit('message:edited', { conversation_id: msg.conversation_id, message: enriched });
      } catch (e) {
        console.error('[message:edit]', e);
      }
    });

    // ─── DELETE MESSAGE ───────────────────────────────────────────
    socket.on('message:delete', async ({ message_id, deleteForEveryone }) => {
      try {
        const msg = await db.messages.findOne({ _id: message_id, sender_id: userId });
        if (!msg) return;
        if (deleteForEveryone) {
          await db.messages.update({ _id: message_id }, { $set: { deleted: 1, content: 'This message was deleted' } });
          io.to(`conv:${msg.conversation_id}`).emit('message:deleted', { conversation_id: msg.conversation_id, message_id });
        } else {
          socket.emit('message:deleted', { conversation_id: msg.conversation_id, message_id });
        }
      } catch (e) {
        console.error('[message:delete]', e);
      }
    });

    // ─── REACT ────────────────────────────────────────────────────
    socket.on('message:react', async ({ message_id, emoji }) => {
      try {
        const msg = await db.messages.findOne({ _id: message_id });
        if (!msg) return;
        const membership = await db.members.findOne({ conversation_id: msg.conversation_id, user_id: userId });
        if (!membership) return;

        const existing = await db.reactions.findOne({ message_id, user_id: userId, emoji });
        if (existing) {
          await db.reactions.remove({ _id: existing._id });
        } else {
          await db.reactions.insert({ _id: uuidv4(), message_id, user_id: userId, emoji, created_at: Math.floor(Date.now() / 1000) });
        }

        const reactions = await db.reactions.find({ message_id });
        io.to(`conv:${msg.conversation_id}`).emit('message:reacted', {
          conversation_id: msg.conversation_id,
          message_id,
          reactions: reactions.map(r => ({ emoji: r.emoji, user_id: r.user_id })),
        });
      } catch (e) {
        console.error('[message:react]', e);
      }
    });

    // ─── PIN MESSAGE ──────────────────────────────────────────────
    socket.on('message:pin', async ({ message_id }, ack) => {
      try {
        const msg = await db.messages.findOne({ _id: message_id });
        if (!msg) return ack?.({ error: 'Not found' });
        const membership = await db.members.findOne({ conversation_id: msg.conversation_id, user_id: userId });
        if (!membership) return ack?.({ error: 'Not a member' });

        const existing = await db.pins.findOne({ message_id });
        if (existing) {
          await db.pins.remove({ _id: existing._id });
        } else {
          await db.pins.insert({ _id: uuidv4(), conversation_id: msg.conversation_id, message_id, pinned_by: userId, pinned_at: Math.floor(Date.now() / 1000) });
        }

        io.to(`conv:${msg.conversation_id}`).emit('message:pinned', { conversation_id: msg.conversation_id, message_id });
        ack?.({ success: true });
      } catch (e) {
        console.error('[message:pin]', e);
        ack?.({ error: 'Failed' });
      }
    });

    // ─── READ RECEIPTS ────────────────────────────────────────────
    socket.on('message:read', async ({ conversation_id, message_ids }) => {
      try {
        if (!message_ids?.length) return;
        const now = Math.floor(Date.now() / 1000);

        for (const mid of message_ids) {
          const exists = await db.reads.findOne({ message_id: mid, user_id: userId });
          if (!exists) await db.reads.insert({ _id: uuidv4(), message_id: mid, user_id: userId, read_at: now });
        }

        await db.members.update({ conversation_id, user_id: userId }, { $set: { last_read_at: now } });

        const msgs = await db.messages.find({ _id: { $in: message_ids } });
        const senderIds = [...new Set(msgs.map(m => m.sender_id).filter(id => id !== userId))];
        for (const sid of senderIds) {
          for (const sock of getSocketsForUser(io, sid)) {
            sock.emit('message:seen', { conversation_id, user_id: userId, message_ids });
          }
        }
      } catch (e) {
        console.error('[message:read]', e);
      }
    });

    // ─── DELIVERED RECEIPTS ───────────────────────────────────────
    socket.on('message:delivered', async ({ conversation_id, message_ids }) => {
      try {
        if (!message_ids?.length) return;
        const msgs = await db.messages.find({ _id: { $in: message_ids } });
        const senderIds = [...new Set(msgs.map(m => m.sender_id).filter(id => id !== userId))];
        for (const sid of senderIds) {
          for (const sock of getSocketsForUser(io, sid)) {
            sock.emit('message:delivered', { conversation_id, message_ids });
          }
        }
      } catch (e) {
        console.error('[message:delivered]', e);
      }
    });

    // ─── TYPING ───────────────────────────────────────────────────
    socket.on('typing:start', async ({ conversation_id }) => {
      const membership = await db.members.findOne({ conversation_id, user_id: userId });
      if (!membership) return;
      socket.to(`conv:${conversation_id}`).emit('typing:start', { conversation_id, user_id: userId, display_name: user.display_name });
    });

    socket.on('typing:stop', async ({ conversation_id }) => {
      socket.to(`conv:${conversation_id}`).emit('typing:stop', { conversation_id, user_id: userId });
    });

    // ═══════════════════════════════════════════════════════════════
    // VOICE/VIDEO CALLS — routed by target_user_id, tracked by call_id
    // Frontend emits: call:offer, call:answer, call:reject, call:end,
    //   call:timeout, call:ice-candidate — all carry { call_id, target_user_id, ... }
    // ═══════════════════════════════════════════════════════════════

    // Caller initiates — frontend emits 'call:offer'
    socket.on('call:offer', async ({ call_id, target_user_id, conversation_id, call_type, offer }) => {
      if (!call_id || !target_user_id || !conversation_id || !offer) return;
      console.log(`[call:offer] ${user.display_name} → ${target_user_id} (${call_id})`);

      // Busy check — callee already ringing/active on another call
      const calleeBusy = findActiveCallForUser(target_user_id);
      const callerBusy = findActiveCallForUser(userId);
      if (calleeBusy || callerBusy) {
        socket.emit('call:busy');
        return;
      }

      // Privacy check — callee call reception permissions
      const targetUserDoc = await db.users.findOne({ _id: target_user_id });
      if (targetUserDoc) {
        if (targetUserDoc.privacy_calls === 'nobody') {
          socket.emit('call:declined');
          return;
        }
        if (targetUserDoc.privacy_calls === 'contacts') {
          const isContact = await db.contacts.findOne({ user_id: target_user_id, contact_user_id: userId });
          if (!isContact) {
            socket.emit('call:declined');
            return;
          }
        }
      }

      const targetSockets = getSocketsForUser(io, target_user_id);
      if (!targetSockets.length) {
        // Target is offline — nothing to ring, immediately report as missed
        socket.emit('call:unavailable');
        return;
      }

      activeCalls.set(call_id, {
        callId: call_id,
        callerId: userId,
        callerName: user.display_name,
        calleeId: target_user_id,
        calleeName: null,
        conversationId: conversation_id,
        callType: call_type === 'video' ? 'video' : 'voice',
        status: 'ringing',
        startedAt: Date.now(),
        connectedAt: null,
      });

      for (const sock of targetSockets) {
        sock.emit('call:incoming', {
          call_id,
          conversation_id,
          call_type: call_type || 'voice',
          from_user_id: userId,
          from_display_name: user.display_name,
          offer,
        });
      }
    });

    // Callee answers — frontend emits 'call:answer'
    socket.on('call:answer', async ({ call_id, target_user_id, answer }) => {
      console.log(`[call:answer] ${user.display_name} → ${target_user_id} (${call_id})`);
      const call = activeCalls.get(call_id);
      if (call) {
        call.status = 'active';
        call.connectedAt = Date.now();
        call.calleeName = user.display_name;
      }
      for (const sock of getSocketsForUser(io, target_user_id)) {
        sock.emit('call:answered', { call_id, answer });
      }
    });

    // Callee rejects — frontend emits 'call:reject'
    socket.on('call:reject', async ({ call_id, target_user_id }) => {
      console.log(`[call:reject] ${user.display_name} → ${target_user_id} (${call_id})`);
      const call = activeCalls.get(call_id);
      if (call) {
        activeCalls.delete(call_id);
        await logCallMessage(io, call, 'declined');
      }
      for (const sock of getSocketsForUser(io, target_user_id)) {
        sock.emit('call:rejected', { call_id });
      }
    });

    // Caller's ring timed out with no answer — frontend emits 'call:timeout'
    socket.on('call:timeout', async ({ call_id, target_user_id }) => {
      console.log(`[call:timeout] ${user.display_name} → ${target_user_id} (${call_id})`);
      const call = activeCalls.get(call_id);
      if (call) {
        activeCalls.delete(call_id);
        await logCallMessage(io, call, 'missed');
      }
      for (const sock of getSocketsForUser(io, target_user_id)) {
        sock.emit('call:missed', { call_id });
      }
    });

    // Either side ends — frontend emits 'call:end'
    socket.on('call:end', async ({ call_id, target_user_id }) => {
      console.log(`[call:end] ${user.display_name} → ${target_user_id} (${call_id})`);
      const call = call_id ? activeCalls.get(call_id) : null;
      if (call) {
        activeCalls.delete(call_id);
        const status = call.connectedAt ? 'completed' : 'cancelled';
        await logCallMessage(io, call, status);
      }
      if (target_user_id) {
        for (const sock of getSocketsForUser(io, target_user_id)) {
          sock.emit('call:ended', { call_id });
        }
      }
    });

    // ICE candidates — frontend emits 'call:ice-candidate'
    socket.on('call:ice-candidate', async ({ target_user_id, candidate }) => {
      for (const sock of getSocketsForUser(io, target_user_id)) {
        sock.emit('call:ice-candidate', { candidate });
      }
    });

    // ─── DISCONNECT ───────────────────────────────────────────────
    socket.on('disconnect', async () => {
      // If this user drops mid-call (and has no other open tabs/devices), end it gracefully
      const remainingSockets = onlineUsers.get(userId);
      const isLastSocket = !remainingSockets || remainingSockets.size <= 1;
      if (isLastSocket) {
        const call = findActiveCallForUser(userId);
        if (call) {
          activeCalls.delete(call.callId);
          const otherId = call.callerId === userId ? call.calleeId : call.callerId;
          const status = call.connectedAt ? 'completed' : (call.callerId === userId ? 'cancelled' : 'missed');
          await logCallMessage(io, call, status);
          for (const sock of getSocketsForUser(io, otherId)) {
            sock.emit('call:ended', { call_id: call.callId });
          }
        }
      }

      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(userId);
          const now = Math.floor(Date.now() / 1000);
          await db.users.update({ _id: userId }, { $set: { online: 0, last_seen: now } });

          const myMems2 = await db.members.find({ user_id: userId });
          const convIds2 = myMems2.map(m => m.conversation_id);
          if (convIds2.length) {
            const allMems2 = await db.members.find({ conversation_id: { $in: convIds2 }, user_id: { $ne: userId } });
            const contactIds2 = [...new Set(allMems2.map(m => m.user_id))];
            for (const contactId of contactIds2) {
              for (const sock of getSocketsForUser(io, contactId)) {
                sock.emit('user:presence', { user_id: userId, online: false });
              }
            }
          }
        }
      }
      console.log(`[socket] ${user.display_name} disconnected`);
    });
  });
}

module.exports = setupSocket;
