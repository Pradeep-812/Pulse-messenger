const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { authMiddleware } = require('../middleware/auth');
const db = require('../db');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB
  fileFilter: (req, file, cb) => {
    const allowed = /image\/|audio\/|video\/|application\/(pdf|msword|vnd\.|zip|x-zip)|text\//;
    if (allowed.test(file.mimetype)) return cb(null, true);
    cb(new Error('File type not allowed'));
  },
});

function detectType(mimetype) {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('audio/')) return 'voice';
  if (mimetype.startsWith('video/')) return 'video';
  return 'file';
}

function processUploadResponse(file) {
  const type = detectType(file.mimetype);
  const url = `/uploads/${file.filename}`;
  // For images, provide thumbnail reference (or same file / compressed preview)
  const thumbUrl = type === 'image' ? `/uploads/${file.filename}` : null;

  return {
    url,
    file_url: url,
    thumbnail_url: thumbUrl,
    type,
    original_name: file.originalname,
    file_name: file.originalname,
    size: file.size,
    file_size: file.size,
    mimetype: file.mimetype,
  };
}

// POST /api/uploads and POST /api/uploads/file
router.post('/', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json(processUploadResponse(req.file));
});

router.post('/file', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json(processUploadResponse(req.file));
});

// POST /api/uploads/avatar
router.post('/avatar', authMiddleware, upload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!req.file.mimetype.startsWith('image/'))
    return res.status(400).json({ error: 'Must be an image' });

  const url = `/uploads/${req.file.filename}`;
  await db.users.update({ _id: req.userId }, { $set: { avatar: url } });

  res.json({ url, success: true });
});

module.exports = router;
