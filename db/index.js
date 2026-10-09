const Datastore = require('nedb-promises');
const path = require('path');

const DB_DIR = path.join(__dirname, '../data');

const db = {
  users:         Datastore.create({ filename: path.join(DB_DIR, 'users.db'),         autoload: true }),
  conversations: Datastore.create({ filename: path.join(DB_DIR, 'conversations.db'), autoload: true }),
  members:       Datastore.create({ filename: path.join(DB_DIR, 'members.db'),       autoload: true }),
  messages:      Datastore.create({ filename: path.join(DB_DIR, 'messages.db'),      autoload: true }),
  reactions:     Datastore.create({ filename: path.join(DB_DIR, 'reactions.db'),     autoload: true }),
  pins:          Datastore.create({ filename: path.join(DB_DIR, 'pins.db'),          autoload: true }),
  reads:         Datastore.create({ filename: path.join(DB_DIR, 'reads.db'),         autoload: true }),
  blocks:        Datastore.create({ filename: path.join(DB_DIR, 'blocks.db'),        autoload: true }),
  stories:       Datastore.create({ filename: path.join(DB_DIR, 'stories.db'),       autoload: true }),
  subscriptions: Datastore.create({ filename: path.join(DB_DIR, 'subscriptions.db'), autoload: true }),
  sessions:      Datastore.create({ filename: path.join(DB_DIR, 'sessions.db'),      autoload: true }),
  login_logs:    Datastore.create({ filename: path.join(DB_DIR, 'login_logs.db'),    autoload: true }),
  reports:       Datastore.create({ filename: path.join(DB_DIR, 'reports.db'),       autoload: true }),
  spam_filters:  Datastore.create({ filename: path.join(DB_DIR, 'spam_filters.db'),  autoload: true }),
  audit_logs:    Datastore.create({ filename: path.join(DB_DIR, 'audit_logs.db'),    autoload: true }),
  recovery_tokens: Datastore.create({ filename: path.join(DB_DIR, 'recovery_tokens.db'), autoload: true }),
  starred_messages: Datastore.create({ filename: path.join(DB_DIR, 'starred_messages.db'), autoload: true }),
  contacts:      Datastore.create({ filename: path.join(DB_DIR, 'contacts.db'),      autoload: true }),
};

// Ensure indexes
(async () => {
  await db.users.ensureIndex({ fieldName: 'email', unique: true });
  await db.users.ensureIndex({ fieldName: 'username', unique: true });
  await db.messages.ensureIndex({ fieldName: 'conversation_id' });
  await db.members.ensureIndex({ fieldName: 'conversation_id' });
  await db.members.ensureIndex({ fieldName: 'user_id' });
  await db.reads.ensureIndex({ fieldName: 'message_id' });
  await db.reactions.ensureIndex({ fieldName: 'message_id' });
  await db.stories.ensureIndex({ fieldName: 'user_id' });
  await db.stories.ensureIndex({ fieldName: 'expires_at' });
  await db.subscriptions.ensureIndex({ fieldName: 'user_id' });
  await db.sessions.ensureIndex({ fieldName: 'user_id' });
  await db.sessions.ensureIndex({ fieldName: 'token_id' });
  await db.reports.ensureIndex({ fieldName: 'status' });
  await db.audit_logs.ensureIndex({ fieldName: 'timestamp' });
  await db.starred_messages.ensureIndex({ fieldName: 'user_id' });
  await db.contacts.ensureIndex({ fieldName: 'user_id' });
})();

module.exports = db;
