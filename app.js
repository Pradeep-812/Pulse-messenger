require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { socketAuth } = require('./middleware/auth');
const setupSocket = require('./routes/socket');
const { initBackupCron } = require('./services/backupCron');
const { initDisappearingService } = require('./services/disappearingCleaner');
const rateLimit = require('express-rate-limit');

// Ensure data, uploads & backups dirs exist
['data', 'uploads', 'backups'].forEach(dir => {
  const p = path.join(__dirname, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 30e6, // 30 MB for large socket payloads
});

app.set('io', io);

// ── Rate Limiting & DDoS Shield ─────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 requests per minute for sensitive auth endpoints
  message: { error: 'Too many login/auth requests from this IP. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200, // 200 requests per minute general API
  message: { error: 'Rate limit exceeded. Please throttle requests.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Apply rate limiting
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
app.use('/api/', apiLimiter);

// ── Static: serve frontend & uploads ───────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── API Routes ─────────────────────────────────────────────────────────────
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/admin',         require('./routes/admin'));
app.use('/api/reports',       require('./routes/reports'));
app.use('/api/search',        require('./routes/search'));
app.use('/api/users',         require('./routes/users'));
app.use('/api/conversations', require('./routes/conversations'));
app.use('/api/messages',      require('./routes/messages'));
app.use('/api/uploads',       require('./routes/uploads'));
app.use('/api/ai',            require('./routes/ai'));
app.use('/api/backup',        require('./routes/backup'));
app.use('/api/stories',       require('./routes/stories'));
app.use('/api/push',          require('./routes/push'));

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));

// ── Socket.IO ─────────────────────────────────────────────────────────────
io.use(socketAuth);
setupSocket(io);

// ── Background Services ───────────────────────────────────────────────────
initBackupCron();
initDisappearingService(io);

// ── Catch-all: serve frontend SPA ─────────────────────────────────────────
app.get('/{*path}', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: 'Frontend not found. Place index.html in /public/' });
  }
});

// ── Error handler ──────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🟣 Pulse Messenger backend running on http://localhost:${PORT}`);
  console.log(`   API:      http://localhost:${PORT}/api`);
  console.log(`   Frontend: place index.html in ./public/\n`);
});
