const db = require('../db');

let _io = null;

function setSocketIo(io) {
  _io = io;
}

async function runDisappearingCleaner() {
  try {
    const convsWithTimer = await db.conversations.find({ disappearing_timer: { $gt: 0 } });
    const now = Math.floor(Date.now() / 1000);

    for (const conv of convsWithTimer) {
      const timer = conv.disappearing_timer;
      const cutoff = now - timer;

      const expiredMessages = await db.messages.find({
        conversation_id: conv._id,
        created_at: { $lt: cutoff },
        deleted: { $ne: 1 }
      });

      if (expiredMessages.length > 0) {
        const expiredIds = expiredMessages.map(m => m._id);
        await db.messages.remove({ _id: { $in: expiredIds } }, { multi: true });

        // Clean up reads and reactions
        await db.reads.remove({ message_id: { $in: expiredIds } }, { multi: true });
        await db.reactions.remove({ message_id: { $in: expiredIds } }, { multi: true });

        if (_io) {
          _io.to(`conv:${conv._id}`).emit('messages:disappeared', {
            conversation_id: conv._id,
            message_ids: expiredIds,
          });
        }
      }
    }
  } catch (err) {
    console.error('[disappearingCleaner:error]', err);
  }
}

function initDisappearingService(io) {
  if (io) setSocketIo(io);
  // Run every 60 seconds
  setInterval(runDisappearingCleaner, 60 * 1000);
}

module.exports = { initDisappearingService, runDisappearingCleaner };
