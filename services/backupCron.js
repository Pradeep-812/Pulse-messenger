const fs = require('fs');
const path = require('path');
const { createDatabaseSnapshot } = require('../routes/backup');

const BACKUP_DIR = path.join(__dirname, '../backups');
const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_BACKUPS_TO_KEEP = 10;

function rotateOldBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return;
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('pulse_auto_backup') && (f.endsWith('.json.gz') || f.endsWith('.json')))
      .map(filename => ({
        filename,
        path: path.join(BACKUP_DIR, filename),
        mtime: fs.statSync(path.join(BACKUP_DIR, filename)).mtime,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length > MAX_BACKUPS_TO_KEEP) {
      const toDelete = files.slice(MAX_BACKUPS_TO_KEEP);
      toDelete.forEach(f => {
        try {
          fs.unlinkSync(f.path);
          console.log(`[backup:cron] Rotated old backup: ${f.filename}`);
        } catch {}
      });
    }
  } catch (err) {
    console.error('[backup:cron] Error rotating backups:', err.message);
  }
}

async function performAutoBackup() {
  try {
    const snapshot = await createDatabaseSnapshot('pulse_auto_backup');
    console.log(`[backup:cron] ✅ Auto database backup created: ${snapshot.filename} (${snapshot.sizeBytes} bytes)`);
    rotateOldBackups();
  } catch (err) {
    console.error('[backup:cron] ❌ Auto backup failed:', err.message);
  }
}

function initBackupCron() {
  console.log('[backup:cron] Periodic auto-backup service initialized (interval: 6h)');

  // Run initial auto backup after 5s on server start
  setTimeout(() => {
    performAutoBackup();
  }, 5000);

  // Set recurring periodic backup interval
  setInterval(() => {
    performAutoBackup();
  }, BACKUP_INTERVAL_MS);
}

module.exports = {
  initBackupCron,
  performAutoBackup,
};
