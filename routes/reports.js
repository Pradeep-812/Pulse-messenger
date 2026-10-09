const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// POST /api/reports - Submit a report (Instagram Reports style)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { target_type, target_id, reported_user_id, reason, details } = req.body;
    if (!target_type || !target_id || !reason) {
      return res.status(400).json({ error: 'target_type, target_id, and reason are required' });
    }

    // Capture preview snippet if message or story
    let contentPreview = '';
    if (target_type === 'message') {
      const msg = await db.messages.findOne({ _id: target_id });
      if (msg) contentPreview = (msg.content || '').slice(0, 150);
    } else if (target_type === 'story') {
      const story = await db.stories.findOne({ _id: target_id });
      if (story) contentPreview = story.media_url || story.caption || 'Story item';
    }

    const report = await db.reports.insert({
      _id: uuidv4(),
      reporter_id: req.userId,
      reporter_name: req.user?.display_name || req.user?.username,
      reported_user_id: reported_user_id || null,
      target_type, // 'message' | 'story' | 'user' | 'media'
      target_id,
      content_preview: contentPreview,
      reason, // 'spam' | 'harassment' | 'hate_speech' | 'inappropriate_media' | 'scam' | 'other'
      details: details || '',
      status: 'pending', // 'pending' | 'resolved'
      resolution_action: null,
      reviewer_note: null,
      reviewed_by: null,
      created_at: Math.floor(Date.now() / 1000),
    });

    res.json({
      success: true,
      report_id: report._id,
      message: 'Thank you for your report. Our Trust & Safety team will review this promptly.',
    });
  } catch (e) {
    console.error('[reports:create]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/reports/my - User's own submitted reports
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const myReports = await db.reports.find({ reporter_id: req.userId }).sort({ created_at: -1 });
    res.json({ reports: myReports });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
