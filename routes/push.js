const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const pushService = require('../services/pushService');

const router = express.Router();

// GET /api/push/vapid-key
router.get('/vapid-key', (req, res) => {
  const key = pushService.getVapidPublicKey();
  res.json({ publicKey: key });
});

// POST /api/push/subscribe
router.post('/subscribe', authMiddleware, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Valid subscription object required' });
    }
    const id = await pushService.subscribeUser(req.userId, subscription);
    res.json({ success: true, id });
  } catch (err) {
    console.error('[push:subscribe]', err);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// POST /api/push/unsubscribe
router.post('/unsubscribe', authMiddleware, async (req, res) => {
  try {
    const { endpoint } = req.body;
    await pushService.unsubscribeUser(req.userId, endpoint);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

// POST /api/push/test - send a test notification to caller
router.post('/test', authMiddleware, async (req, res) => {
  try {
    await pushService.sendPushToUser(req.userId, {
      title: 'Pulse Messenger',
      body: '🔔 Push notifications are working perfectly on your device!',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: '/' },
    });
    res.json({ success: true, message: 'Test notification triggered' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
