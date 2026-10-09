const express = require('express');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { decrypt } = require('../utils/crypto');

const router = express.Router();

// ── Built-in AI Engine (No external API dependencies) ──────────────────────

// Build a lightweight text transcript from stored messages
function buildTranscript(messages, meUserId) {
  return messages
    .filter(m => !m.deleted)
    .map(m => {
      const content = decrypt(m.content);
      const who = meUserId && m.sender_id === meUserId ? 'Me' : m.sender_name;
      if (m.type === 'text' || m.type === 'ai') return `${who}: ${content}`;
      if (m.type === 'call') return `${who}: [${content}]`;
      return `${who}: [sent a ${m.type}]`;
    })
    .join('\n');
}

// ── Local NLP-style Summarizer (no API keys needed) ─────────────────────────

function extractKeyPhrases(text) {
  const stopWords = new Set([
    'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your',
    'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her',
    'hers', 'herself', 'it', 'its', 'itself', 'they', 'them', 'their', 'theirs',
    'themselves', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
    'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
    'having', 'do', 'does', 'did', 'doing', 'a', 'an', 'the', 'and', 'but', 'if',
    'or', 'because', 'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with',
    'about', 'against', 'between', 'through', 'during', 'before', 'after', 'above',
    'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under',
    'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
    'how', 'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
    'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 's',
    't', 'can', 'will', 'just', 'don', 'should', 'now', 'd', 'll', 'm', 'o', 're',
    've', 'y', 'ain', 'aren', 'couldn', 'didn', 'doesn', 'hadn', 'hasn', 'haven',
    'isn', 'ma', 'mightn', 'mustn', 'needn', 'shan', 'shouldn', 'wasn', 'weren',
    'won', 'wouldn', 'ok', 'okay', 'yeah', 'yes', 'no', 'hi', 'hello', 'hey',
    'thanks', 'thank', 'lol', 'haha', 'hmm', 'oh', 'ah', 'um', 'like', 'also',
    'well', 'really', 'right', 'sure', 'got', 'get', 'going', 'go', 'know',
    'think', 'thing', 'things', 'would', 'could', 'let', 'sent', 'message'
  ]);

  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
  const freq = {};
  words.forEach(w => {
    if (w.length > 2 && !stopWords.has(w)) {
      freq[w] = (freq[w] || 0) + 1;
    }
  });

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([word]) => word);
}

function scoreSentence(sentence, keyPhrases, position, totalSentences) {
  const words = sentence.toLowerCase().split(/\s+/);
  let score = 0;

  // Key phrase match bonus
  for (const phrase of keyPhrases) {
    if (words.includes(phrase)) score += 2;
  }

  // Length bonus (prefer mid-length sentences)
  if (words.length >= 5 && words.length <= 25) score += 1;

  // Position bonus (first and last messages carry more weight)
  if (position < totalSentences * 0.15) score += 2;
  if (position > totalSentences * 0.85) score += 1.5;

  // Question bonus
  if (sentence.includes('?')) score += 1.5;

  // Action/decision keywords
  const actionWords = ['decided', 'agreed', 'plan', 'tomorrow', 'meeting', 'deadline',
    'done', 'finished', 'completed', 'need', 'must', 'important', 'urgent', 'please',
    'confirm', 'update', 'schedule', 'call', 'send', 'share', 'review', 'fix',
    'issue', 'problem', 'solution', 'resolved', 'approve', 'reject', 'changed'];
  for (const w of actionWords) {
    if (sentence.toLowerCase().includes(w)) score += 1.5;
  }

  return score;
}

function localSummarize(messages) {
  if (!messages.length) return 'No messages yet in this conversation.';

  const participants = [...new Set(messages.filter(m => !m.deleted).map(m => m.sender_name))];
  const textMessages = messages.filter(m => !m.deleted && (m.type === 'text' || m.type === 'ai'));
  const mediaMessages = messages.filter(m => !m.deleted && !['text', 'ai', 'system'].includes(m.type));
  const callMessages = messages.filter(m => !m.deleted && m.type === 'call');

  if (textMessages.length === 0) {
    let summary = `- ${messages.length} message(s) between ${participants.join(', ')}.\n`;
    if (mediaMessages.length) summary += `- ${mediaMessages.length} media file(s) shared.\n`;
    if (callMessages.length) summary += `- ${callMessages.length} call(s) made.\n`;
    return summary;
  }

  // Build full text for keyword extraction
  const fullText = textMessages.map(m => decrypt(m.content)).join(' ');
  const keyPhrases = extractKeyPhrases(fullText);

  // Score each message line for importance
  const scored = textMessages.map((m, i) => {
    const content = decrypt(m.content);
    return {
      content,
      sender: m.sender_name,
      score: scoreSentence(content, keyPhrases, i, textMessages.length),
      index: i
    };
  });

  // Pick top scoring messages as summary points
  const topMessages = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .sort((a, b) => a.index - b.index); // restore chronological order

  // Build summary
  let summary = `📊 **Conversation Summary** (${textMessages.length} messages, ${participants.length} participant${participants.length > 1 ? 's' : ''})\n\n`;
  summary += `👥 Participants: ${participants.join(', ')}\n\n`;
  summary += `**Key points:**\n`;

  topMessages.forEach(m => {
    const preview = m.content.length > 120 ? m.content.slice(0, 120) + '…' : m.content;
    summary += `- **${m.sender}**: ${preview}\n`;
  });

  if (keyPhrases.length > 0) {
    summary += `\n🔑 Top topics: ${keyPhrases.slice(0, 8).join(', ')}`;
  }

  if (mediaMessages.length > 0) {
    summary += `\n📎 ${mediaMessages.length} media file(s) shared.`;
  }
  if (callMessages.length > 0) {
    summary += `\n📞 ${callMessages.length} call(s) recorded.`;
  }

  return summary;
}

// ── Built-in Smart Reply Suggestions ────────────────────────────────────────

function generateSmartReplies(messages, meUserId) {
  if (!messages.length) return ["Hey! 👋", "How's it going?", "What's up?"];

  const lastMsg = messages[messages.length - 1];
  const content = decrypt(lastMsg.content).toLowerCase().trim();

  // Question patterns
  if (content.includes('?')) {
    if (content.includes('how are') || content.includes('how r u') || content.includes("how's it")) {
      return ["I'm doing great, thanks! 😊", "Pretty good! How about you?", "All good! What's new?"];
    }
    if (content.includes('when') || content.includes('what time')) {
      return ["Let me check and get back to you", "I'll confirm shortly", "How about tomorrow?"];
    }
    if (content.includes('where')) {
      return ["I'll share the location", "Let me find out", "Same place as last time?"];
    }
    if (content.includes('can you') || content.includes('could you') || content.includes('would you')) {
      return ["Sure, I'll do that! 👍", "Let me check on that", "Of course!"];
    }
    return ["Let me think about it", "Good question!", "I'll get back to you on that"];
  }

  // Greeting patterns
  if (/^(hi|hello|hey|yo|sup|what'?s? up)\b/.test(content)) {
    return ["Hey! How's it going? 👋", "Hi there! 😊", "What's up?"];
  }

  // Thanks patterns
  if (/^(thanks|thank you|thx|ty)\b/.test(content)) {
    return ["You're welcome! 😊", "No problem!", "Anytime! 👍"];
  }

  // Agreement patterns
  if (/^(ok|okay|sure|alright|sounds good|great|perfect|nice|cool)\b/.test(content)) {
    return ["Great! 👍", "Awesome!", "Sounds good to me too!"];
  }

  // Sorry/apology
  if (/^(sorry|my bad|apologies)\b/.test(content)) {
    return ["No worries! 😊", "It's all good!", "Don't worry about it"];
  }

  // Farewell
  if (/^(bye|goodbye|good night|gn|see you|later|cya)\b/.test(content)) {
    return ["See you! 👋", "Take care!", "Bye! Talk soon 😊"];
  }

  // Default contextual replies
  return ["Got it! 👍", "I'll take a look", "Thanks for sharing!"];
}

// ── Built-in Chat Response ──────────────────────────────────────────────────

function generateBuiltinResponse(prompt) {
  const p = (prompt || '').trim().toLowerCase();

  if (!p) {
    return "👋 Hello! I am **Pulse AI Assistant**. Type `@ai <your question>` in any chat to ask me anything!";
  }

  if (/^(hi|hello|hey|vanakkam|vanakam|namaste|hola)\b/.test(p)) {
    return `👋 Hello! I'm **Pulse AI**, your in-chat assistant. How can I help you today? You can ask me for calculations, summaries, translations, or quick explanations!`;
  }

  if (p.includes('who are you') || p.includes('what can you do') || p.includes('who made you')) {
    return `🤖 I am **Pulse AI Assistant**, embedded directly inside Pulse Messenger!\nI can help with:\n• Instant question answers & explanations\n• Calculations and conversions\n• Summarizing discussions\n• Formatting text, drafting notes\n• Time, date, jokes, and more!`;
  }

  // Simple math solver
  const mathMatch = p.match(/(?:what is|calculate|calc|solve)?\s*([\d\s\+\-\*\/\^\(\)\.%]+)$/);
  if (mathMatch && mathMatch[1] && /[0-9]/.test(mathMatch[1]) && !/[a-z]/.test(mathMatch[1])) {
    try {
      const cleaned = mathMatch[1].replace(/[^0-9\+\-\*\/\(\)\.\s]/g, '');
      const result = Function(`'use strict'; return (${cleaned})`)();
      return `🔢 Calculation result: **${cleaned.trim()} = ${result}**`;
    } catch { /* fallback */ }
  }

  if (p.includes('time') || p.includes('date')) {
    const now = new Date();
    return `🕒 Current date and time: **${now.toLocaleString()}**`;
  }

  if (p.includes('joke')) {
    const jokes = [
      "Why do programmers prefer dark mode? Because light attracts bugs! 🐛",
      "There are 10 types of people in the world: those who understand binary, and those who don't.",
      "A SQL query walks into a bar, walks up to two tables and asks: 'Can I join you?'",
      "Why was the JavaScript developer sad? Because he didn't Node how to Express himself!",
      "What's a programmer's favorite hangout place? Foo Bar! 🍺"
    ];
    return jokes[Math.floor(Math.random() * jokes.length)];
  }

  // Conversion helpers
  if (p.includes('convert') || p.includes('how many')) {
    if (p.includes('km') && p.includes('mile')) return `1 km = 0.621371 miles`;
    if (p.includes('mile') && p.includes('km')) return `1 mile = 1.60934 km`;
    if (p.includes('celsius') || p.includes('fahrenheit')) return `Formula: °F = (°C × 9/5) + 32 | °C = (°F − 32) × 5/9`;
    if (p.includes('kg') && p.includes('pound')) return `1 kg = 2.20462 pounds`;
  }

  return `🤖 **Pulse AI Assistant**\n\nI received your query: *"${prompt.trim()}"*\n\n💡 This is Pulse's built-in AI engine. I can help with calculations, time queries, jokes, unit conversions, and smart replies!`;
}

async function generateAiChatResponse(prompt, convId, userId) {
  return generateBuiltinResponse(prompt);
}

// ── API Routes ──────────────────────────────────────────────────────────────

// POST /api/ai/suggest-replies { conversation_id }
router.post('/suggest-replies', authMiddleware, async (req, res) => {
  try {
    const { conversation_id } = req.body || {};
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id required' });

    const membership = await db.members.findOne({ conversation_id, user_id: req.userId });
    if (!membership) return res.status(403).json({ error: 'Not a member' });

    const recent = await db.messages.find({ conversation_id }).sort({ created_at: -1 }).limit(12);
    recent.reverse();
    if (!recent.length) return res.json({ suggestions: [] });

    const suggestions = generateSmartReplies(recent, req.userId);
    res.json({ suggestions });
  } catch (e) {
    console.error('[ai:suggest-replies]', e);
    res.status(500).json({ error: e.message || 'Failed to generate suggestions' });
  }
});

// POST /api/ai/summarize { conversation_id }
router.post('/summarize', authMiddleware, async (req, res) => {
  try {
    const { conversation_id } = req.body || {};
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id required' });

    const membership = await db.members.findOne({ conversation_id, user_id: req.userId });
    if (!membership) return res.status(403).json({ error: 'Not a member' });

    const recent = await db.messages.find({ conversation_id }).sort({ created_at: -1 }).limit(60);
    recent.reverse();
    if (!recent.length) return res.json({ summary: 'No messages yet in this conversation.' });

    const summary = localSummarize(recent);
    res.json({ summary });
  } catch (e) {
    console.error('[ai:summarize]', e);
    res.status(500).json({ error: e.message || 'Failed to summarize conversation' });
  }
});

// POST /api/ai/ask { prompt, conversation_id }
router.post('/ask', authMiddleware, async (req, res) => {
  try {
    const { prompt, conversation_id } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });
    const reply = await generateAiChatResponse(prompt, conversation_id, req.userId);
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message || 'AI request failed' });
  }
});

module.exports = router;
module.exports.generateAiChatResponse = generateAiChatResponse;
module.exports.buildTranscript = buildTranscript;
