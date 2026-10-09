const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const db = require('../db');

const VAPID_FILE = path.join(__dirname, '../data/vapid.json');
let vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
};

// If not provided in environment, generate and persist automatically
if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
  if (fs.existsSync(VAPID_FILE)) {
    try {
      vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    } catch (e) {
      console.warn('[pushService] Failed to read vapid.json, regenerating keys');
    }
  }

  if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
    const generated = webpush.generateVAPIDKeys();
    vapidKeys = {
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
    };
    try {
      fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2), 'utf8');
      console.log('[pushService] 🔑 Generated and saved new VAPID keys');
    } catch (e) {
      console.error('[pushService] Error saving VAPID keys:', e);
    }
  }
}

try {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:support@pulsemessenger.app',
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );
  console.log('[pushService] ✅ Web Push configured with VAPID');
} catch (err) {
  console.error('[pushService] Error configuring web-push:', err.message);
}

function getVapidPublicKey() {
  return vapidKeys.publicKey;
}

async function subscribeUser(userId, subscription) {
  if (!subscription || !subscription.endpoint) return null;
  // Upsert subscription
  const existing = await db.subscriptions.findOne({ endpoint: subscription.endpoint });
  const now = Math.floor(Date.now() / 1000);
  if (existing) {
    await db.subscriptions.update(
      { _id: existing._id },
      { $set: { user_id: userId, subscription, updated_at: now } }
    );
    return existing._id;
  }
  const res = await db.subscriptions.insert({
    user_id: userId,
    subscription,
    created_at: now,
    updated_at: now,
  });
  return res._id;
}

async function unsubscribeUser(userId, endpoint) {
  if (endpoint) {
    await db.subscriptions.remove({ endpoint }, { multi: true });
  } else {
    await db.subscriptions.remove({ user_id: userId }, { multi: true });
  }
}

async function sendPushToUser(userId, payload) {
  try {
    const subs = await db.subscriptions.find({ user_id: userId });
    if (!subs.length) return;

    const bodyString = typeof payload === 'string' ? payload : JSON.stringify(payload);

    const promises = subs.map(async (subDoc) => {
      try {
        await webpush.sendNotification(subDoc.subscription, bodyString);
      } catch (err) {
        // If expired / gone (410 or 404), cleanup subscription
        if (err.statusCode === 404 || err.statusCode === 410) {
          await db.subscriptions.remove({ _id: subDoc._id });
        } else {
          console.warn('[pushService] push send error:', err.statusCode || err.message);
        }
      }
    });

    await Promise.allSettled(promises);
  } catch (err) {
    console.error('[pushService:sendPushToUser] error:', err.message);
  }
}

async function sendPushToUsers(userIds, payload) {
  if (!Array.isArray(userIds) || !userIds.length) return;
  return Promise.allSettled(userIds.map(uid => sendPushToUser(uid, payload)));
}

module.exports = {
  getVapidPublicKey,
  subscribeUser,
  unsubscribeUser,
  sendPushToUser,
  sendPushToUsers,
};
