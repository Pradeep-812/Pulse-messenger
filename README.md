# 🟣 Pulse Messenger — Backend

Full-featured real-time backend for the Pulse Messenger web app.
Built with **Node.js + Express + Socket.IO + NeDB** (zero-config file-based database).

Off Campus code 25UZS7
---

## 📁 Project Structure

```
pulse-messenger/
├── app.js                   # Entry point
├── .env.example             # Environment variable template
├── db/
│   └── index.js             # NeDB database setup & indexes
├── middleware/
│   └── auth.js              # JWT auth (HTTP + Socket.IO)
├── routes/
│   ├── auth.js              # Register / login / profile
│   ├── users.js             # User search, block/unblock
│   ├── conversations.js     # DMs, groups, members, pinned
│   ├── messages.js          # Fetch messages (REST, paginated)
│   ├── uploads.js           # File / image / voice upload
│   └── socket.js            # All real-time Socket.IO events
├── public/
│   └── index.html           # Frontend (place your HTML here)
├── uploads/                 # Uploaded files (auto-created)
└── data/                    # Database files (auto-created)
    ├── users.db
    ├── conversations.db
    ├── members.db
    ├── messages.db
    ├── reactions.db
    ├── pins.db
    ├── reads.db
    └── blocks.db
```

---

## 🚀 Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Create .env
cp .env.example .env
# Edit JWT_SECRET to something random!

# 3. Place the frontend
cp /path/to/pulse-messenger.html public/index.html

# 4. Start
npm start
# → http://localhost:3000
```

For development with auto-restart:
```bash
npm run dev
```

---

## 🔌 REST API Reference

### Auth

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | `{display_name, username, email, password}` | Create account |
| POST | `/api/auth/login` | `{email, password}` | Login → JWT |
| GET | `/api/auth/me` | — | Get current user |
| PUT | `/api/auth/profile` | `{display_name?, bio?, status?}` | Update profile |

### Users

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/users/search?q=<query>` | Search users (min 2 chars) |
| POST | `/api/users/block` | Block a user `{user_id}` |
| DELETE | `/api/users/block/:userId` | Unblock a user |

### Conversations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/conversations` | List all conversations |
| POST | `/api/conversations/direct` | Start/get DM `{user_id}` |
| POST | `/api/conversations/group` | Create group `{name, member_ids[]}` |
| GET | `/api/conversations/:id/members` | List group members |
| GET | `/api/conversations/:id/pinned` | Get pinned messages |

### Messages

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/messages/:convId?limit=60&before=<ts>` | Paginated messages |

### Uploads

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/uploads/file` | Upload any file (multipart) → `{url, type, ...}` |
| POST | `/api/uploads/avatar` | Upload profile avatar |

All REST endpoints except register/login require:
```
Authorization: Bearer <token>
```

---

## ⚡ Socket.IO Events

### Client → Server

| Event | Payload | Description |
|-------|---------|-------------|
| `conversation:join` | `{conversation_id}` | Join a room |
| `message:send` | `{conversation_id, content, type, reply_to?, file_url?, file_name?, file_size?}` | Send message |
| `message:edit` | `{message_id, content}` | Edit own message |
| `message:delete` | `{message_id, deleteForEveryone}` | Delete message |
| `message:react` | `{message_id, emoji}` | Toggle emoji reaction |
| `message:pin` | `{message_id}` | Toggle pin on message |
| `message:read` | `{conversation_id, message_ids[]}` | Mark messages as read |
| `typing:start` | `{conversation_id}` | Start typing indicator |
| `typing:stop` | `{conversation_id}` | Stop typing indicator |
| `call:start` | `{conversation_id, call_type, offer}` | Initiate WebRTC call |
| `call:answer` | `{conversation_id, answer}` | Answer a call |
| `call:reject` | `{conversation_id}` | Reject call |
| `call:end` | `{conversation_id}` | End call |
| `call:ice-candidate` | `{conversation_id, candidate}` | ICE candidate relay |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `message:new` | `{conversation_id, message}` | New message received |
| `message:edited` | `{conversation_id, message}` | Message was edited |
| `message:deleted` | `{conversation_id, message_id}` | Message was deleted |
| `message:reacted` | `{conversation_id, message_id, reactions[]}` | Reactions updated |
| `message:pinned` | `{conversation_id, message_id}` | Message pinned/unpinned |
| `message:seen` | `{conversation_id, user_id, message_ids[]}` | Read receipt |
| `typing:start` | `{conversation_id, user_id, display_name}` | User typing |
| `typing:stop` | `{conversation_id, user_id}` | User stopped typing |
| `user:presence` | `{user_id, online}` | User online/offline |
| `call:incoming` | `{conversation_id, call_type, from_user_id, from_display_name, offer}` | Incoming call |
| `call:answered` | `{answer}` | Call was answered |
| `call:rejected` | — | Call was rejected |
| `call:ended` | — | Call ended |
| `call:ice-candidate` | `{candidate}` | ICE candidate relay |

---

## 🌐 Deployment

### Render.com

1. Push code to GitHub
2. New Web Service → connect repo
3. Build: `npm install`
4. Start: `npm start`
5. Add env var `JWT_SECRET=<random string>`

**Note:** NeDB stores data in the filesystem. Use a persistent disk in Render (Disk section in settings, mount path `/opt/render/project/src/data`).

### Railway / Fly.io / VPS

Same — ensure `data/` and `uploads/` directories persist across deploys (use a volume/disk).

---

## 🔧 Features Implemented

- ✅ JWT authentication (register, login, auto-login)
- ✅ Real-time messaging via Socket.IO
- ✅ Direct messages & group chats
- ✅ Typing indicators
- ✅ Read receipts (double-tick)
- ✅ Emoji reactions (toggle)
- ✅ Reply to messages (with quoted preview)
- ✅ Edit messages
- ✅ Delete for me / delete for everyone
- ✅ Pin messages
- ✅ File & image uploads (25 MB limit)
- ✅ Voice message uploads
- ✅ Online/offline presence
- ✅ Last seen timestamps
- ✅ User search
- ✅ Block users
- ✅ WebRTC voice/video call signalling
- ✅ Profile editing (name, bio, status, avatar)
- ✅ Unread message counts
- ✅ Conversation pagination (load older messages with `?before=<ts>`)
