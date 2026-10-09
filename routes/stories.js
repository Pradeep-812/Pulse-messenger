const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Helper: purge expired stories (> 24 hours old)
async function purgeExpiredStories() {
  const now = Math.floor(Date.now() / 1000);
  try {
    await db.stories.remove({ expires_at: { $lte: now } }, { multi: true });
  } catch (e) {
    console.error('[stories:purge]', e);
  }
}

// GET /api/stories - get active stories grouped by user
router.get('/', authMiddleware, async (req, res) => {
  try {
    await purgeExpiredStories();
    const now = Math.floor(Date.now() / 1000);

    // Find all active stories
    const activeStories = await db.stories.find({ expires_at: { $gt: now } }).sort({ created_at: 1 });

    // Find blocked users to filter them out
    const blocks = await db.blocks.find({
      $or: [{ blocker_id: req.userId }, { blocked_id: req.userId }]
    });
    const blockedIds = new Set(blocks.flatMap(b => [b.blocker_id, b.blocked_id]));

    // Fetch user details
    const userIds = [...new Set(activeStories.map(s => s.user_id))];
    const users = await db.users.find({ _id: { $in: userIds } });
    const userMap = {};
    users.forEach(u => {
      userMap[u._id] = {
        id: u._id,
        display_name: u.display_name,
        username: u.username,
        avatar: u.avatar || null,
      };
    });

    const myStories = [];
    const othersMap = new Map(); // userId -> { user, stories, all_viewed }

    for (const story of activeStories) {
      if (blockedIds.has(story.user_id) && story.user_id !== req.userId) {
        continue;
      }

      const formattedStory = {
        id: story._id,
        user_id: story.user_id,
        type: story.type, // 'text' | 'image' | 'video'
        content: story.content || '',
        media_url: story.media_url || null,
        caption: story.caption || '',
        background_color: story.background_color || '#1e1b4b',
        created_at: story.created_at,
        expires_at: story.expires_at,
        viewed: Array.isArray(story.viewers) && story.viewers.includes(req.userId),
        viewers_count: Array.isArray(story.viewers) ? story.viewers.length : 0,
      };

      if (story.user_id === req.userId) {
        myStories.push(formattedStory);
      } else {
        if (!othersMap.has(story.user_id)) {
          othersMap.set(story.user_id, {
            user: userMap[story.user_id] || { id: story.user_id, display_name: 'Unknown User' },
            stories: [],
            all_viewed: true,
          });
        }
        const group = othersMap.get(story.user_id);
        group.stories.push(formattedStory);
        if (!formattedStory.viewed) {
          group.all_viewed = false;
        }
      }
    }

    // Sort contacts: unviewed stories first, then most recently updated
    const contactStories = Array.from(othersMap.values()).sort((a, b) => {
      if (a.all_viewed !== b.all_viewed) return a.all_viewed ? 1 : -1;
      const latestA = a.stories[a.stories.length - 1]?.created_at || 0;
      const latestB = b.stories[b.stories.length - 1]?.created_at || 0;
      return latestB - latestA;
    });

    res.json({
      my_stories: myStories,
      contact_stories: contactStories,
    });
  } catch (err) {
    console.error('[stories:get]', err);
    res.status(500).json({ error: 'Server error loading stories' });
  }
});

// POST /api/stories - create new story
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { type = 'text', content, media_url, caption, background_color } = req.body;
    if (type === 'text' && !content?.trim()) {
      return res.status(400).json({ error: 'Story content is required' });
    }
    if ((type === 'image' || type === 'video') && !media_url) {
      return res.status(400).json({ error: 'Media URL is required' });
    }

    const user = await db.users.findOne({ _id: req.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + (24 * 60 * 60); // Exact 24 hours expiry

    const newStory = await db.stories.insert({
      _id: uuidv4(),
      user_id: req.userId,
      user_name: user.display_name,
      user_avatar: user.avatar || null,
      type,
      content: content ? content.trim() : '',
      media_url: media_url || null,
      caption: caption ? caption.trim() : '',
      background_color: background_color || '#1e1b4b',
      viewers: [],
      created_at: now,
      expires_at: expiresAt,
    });

    // Broadcast new story event via Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.emit('story:created', {
        story: {
          id: newStory._id,
          user_id: req.userId,
          user_name: user.display_name,
          user_avatar: user.avatar,
          type: newStory.type,
          created_at: newStory.created_at,
        }
      });
    }

    res.status(201).json({
      success: true,
      story: {
        id: newStory._id,
        user_id: req.userId,
        type: newStory.type,
        content: newStory.content,
        media_url: newStory.media_url,
        caption: newStory.caption,
        background_color: newStory.background_color,
        created_at: newStory.created_at,
        expires_at: newStory.expires_at,
        viewers_count: 0,
      }
    });
  } catch (err) {
    console.error('[stories:post]', err);
    res.status(500).json({ error: 'Failed to create story' });
  }
});

// POST /api/stories/:id/view - mark story as viewed
router.post('/:id/view', authMiddleware, async (req, res) => {
  try {
    const story = await db.stories.findOne({ _id: req.params.id });
    if (!story) return res.status(404).json({ error: 'Story not found' });

    const viewers = Array.isArray(story.viewers) ? story.viewers : [];
    if (!viewers.includes(req.userId)) {
      viewers.push(req.userId);
      await db.stories.update({ _id: story._id }, { $set: { viewers } });
    }

    res.json({ success: true, viewers_count: viewers.length });
  } catch (err) {
    console.error('[stories:view]', err);
    res.status(500).json({ error: 'Failed to mark viewed' });
  }
});

// GET /api/stories/:id/viewers - get list of viewers (only story owner)
router.get('/:id/viewers', authMiddleware, async (req, res) => {
  try {
    const story = await db.stories.findOne({ _id: req.params.id });
    if (!story) return res.status(404).json({ error: 'Story not found' });
    if (story.user_id !== req.userId) return res.status(403).json({ error: 'Access denied' });

    const viewers = Array.isArray(story.viewers) ? story.viewers : [];
    const users = await db.users.find({ _id: { $in: viewers } });
    const result = users.map(u => ({
      id: u._id,
      display_name: u.display_name,
      username: u.username,
      avatar: u.avatar || null,
    }));

    res.json({ viewers: result });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch viewers' });
  }
});

// DELETE /api/stories/:id - delete own story
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const story = await db.stories.findOne({ _id: req.params.id });
    if (!story) return res.status(404).json({ error: 'Story not found' });
    if (story.user_id !== req.userId) return res.status(403).json({ error: 'Access denied' });

    await db.stories.remove({ _id: story._id });

    const io = req.app.get('io');
    if (io) {
      io.emit('story:deleted', { story_id: story._id, user_id: req.userId });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete story' });
  }
});

module.exports = router;
