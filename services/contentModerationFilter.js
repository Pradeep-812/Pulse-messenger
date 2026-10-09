const db = require('../db');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_TOXIC_KEYWORDS = [
  'free crypto',
  'claim reward',
  'whatsapp hack',
  'send money now',
  'urgent transfer',
  'toxic_scam_link',
  'offensive_slur',
];

async function checkContentSpam(text, userId, targetType, targetId) {
  if (!text || typeof text !== 'string') return { isFlagged: false };

  const lower = text.toLowerCase();
  const dbFilters = await db.spam_filters.find({});
  const allKeywords = [
    ...DEFAULT_TOXIC_KEYWORDS,
    ...dbFilters.map(f => f.keyword),
  ];

  let matchedKeyword = null;
  for (const kw of allKeywords) {
    if (kw && lower.includes(kw.toLowerCase())) {
      matchedKeyword = kw;
      break;
    }
  }

  // Toxic link detector (e.g. suspicious shorteners, phishing patterns)
  const hasPhishingPattern = /https?:\/\/(?:bit\.ly|tinyurl\.com|free-gift-promo|crypto-bonus)\S*/i.test(text);

  if (matchedKeyword || hasPhishingPattern) {
    const reason = hasPhishingPattern ? 'toxic_links' : 'offensive_words';
    // Auto-create moderation report
    await db.reports.insert({
      _id: uuidv4(),
      reporter_id: 'system_auto_filter',
      reporter_name: '🛡️ Pulse Automated Shield',
      reported_user_id: userId,
      target_type: targetType,
      target_id: targetId,
      content_preview: text.slice(0, 150),
      reason,
      details: `Automated detection triggered by keyword/link pattern: "${matchedKeyword || 'Phishing URL'}"`,
      status: 'pending',
      resolution_action: null,
      created_at: Math.floor(Date.now() / 1000),
    });

    return {
      isFlagged: true,
      reason,
      keyword: matchedKeyword || 'Phishing URL',
    };
  }

  return { isFlagged: false };
}

module.exports = { checkContentSpam };
