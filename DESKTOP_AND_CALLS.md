# 🖥️ Deploying Pulse Messenger as Desktop Software

## 🆕 What's new in this upgrade

Real-time calling was upgraded from "voice-only, best-effort" to a full
call system:

- **Video calls** — the 📹 button now actually works. Local preview (PiP,
  mirrored) + full-screen remote video, with a camera on/off toggle
  alongside mute.
- **Ringtone & ringback tone** — the caller hears a ringback tone while
  waiting, the callee hears a ringtone on the incoming-call toast. Both are
  generated with the Web Audio API, so there are no audio assets to ship.
- **Missed-call auto-timeout** — an unanswered call auto-cancels after 30s
  and is logged as a missed call for both sides.
- **Busy detection** — calling someone who's already on a call now gets an
  immediate "user is on another call" response instead of ringing forever.
- **Offline detection** — calling someone with no open connection reports
  "user is offline" right away instead of ringing into silence.
- **Call history in chat** — every call now leaves a small pill message in
  the conversation ("📞 Voice call · 2:15", "📹 Missed video call", "Call
  declined", etc.), exactly like WhatsApp/Telegram/Signal. Tap it to redial.
- **Live call duration** — a running mm:ss timer shows once a call connects.
- **call_id-based signaling** — every call now carries a unique `call_id`
  through offer/answer/ICE/end so concurrent or overlapping call attempts
  can't cross-talk.
- **Graceful disconnect handling** — closing the tab or losing connection
  mid-call now ends the call cleanly for the other party and logs it,
  instead of leaving them hanging.

Everything below (TURN server, DOM audio element, ICE candidate queueing)
was already fixed in the base app and is unchanged — the notes are kept for
reference.

---

This wraps the existing web app in Electron so it runs as a native installable
app on Windows/macOS/Linux instead of a browser tab.

## Two deployment modes

### Mode A — Self-contained desktop app (server runs inside the app)
Good for: single-machine use, demos, LAN-only use.

```bash
npm run electron        # test it locally first
npm run dist:win        # → dist-electron/Pulse Messenger Setup.exe
npm run dist:mac        # → dist-electron/Pulse Messenger.dmg
npm run dist:linux      # → dist-electron/Pulse Messenger.AppImage
```

The Node/Express/Socket.IO backend boots automatically inside the Electron
process on `localhost:3000`. Each install has its own local database — this
mode does **not** sync between multiple users/devices.

### Mode B — Desktop client connecting to your deployed server (recommended)
Good for: real multi-user messaging across devices, exactly what you want for
calling between devices.

1. Deploy the backend to Render/Railway/VPS (see deployment guide).
2. Set the env var before building:
   ```bash
   PULSE_SERVER_URL=https://your-app.onrender.com npm run dist:win
   ```
3. Every install now points at your shared, always-on backend — messages and
   calls sync properly between every device that has it installed.

This is the mode you want if people on different devices need to call each
other — Mode A's "embedded server per device" can't relay calls between two
separate installs.

---

# 📞 Why call audio didn't work across devices — and the fix

Three bugs were found and fixed:

## 1. No TURN server (the main cause)
The app only had STUN servers configured. STUN only helps two devices find
each other's *public* address — it does **not** work when a direct
peer-to-peer audio stream can't punch through both devices' NAT/firewalls,
which is the normal case when:
- the two devices are on different WiFi networks, or
- one is on mobile data, or
- either router uses symmetric NAT (common with carrier-grade NAT, corporate
  networks, some home routers)

In all of these — which is most real-world cross-device testing — the call
"connects" (offer/answer exchange succeeds) but **no media ever flows**,
because there's no relay to fall back to.

**Fix:** Added a free TURN relay (OpenRelay) alongside the STUN servers, so
when direct P2P fails, audio routes through the relay instead.

> ⚠️ The free OpenRelay TURN server is fine for testing but rate-limited.
> For production, get a TURN server from [Twilio](https://www.twilio.com/stun-turn),
> [Metered.ca](https://www.metered.ca/tools/openrelay/), or self-host
> [coturn](https://github.com/coturn/coturn) on your VPS.

## 2. Remote `<audio>` element wasn't attached to the DOM
The incoming audio stream was played via a detached `new Audio()` element.
Several browsers (Safari/iOS especially, some Chrome versions) block or
unreliably autoplay audio elements that aren't part of the document.

**Fix:** The remote audio element is now created once, appended to the page,
marked `playsInline`, and properly torn down when the call ends. Also added a
fallback: if autoplay is blocked, it retries on the next click anywhere on
the page.

## 3. ICE candidates arriving before the connection was ready were dropped
WebRTC can deliver ICE candidates from the other side before
`setRemoteDescription` has finished — this is normal and timing-dependent.
The old code tried to add them immediately and silently failed if the
remote description wasn't set yet, which could prevent the connection from
ever finishing.

**Fix:** Added a queue — candidates that arrive too early are held and
flushed automatically the moment the remote description is set.

---

## How to verify it's fixed

1. Open the **browser console** (F12) on both devices during a call.
2. Watch for `[call] connection state:` and `[call] ICE state:` logs.
3. You want to see `iceConnectionState` reach `connected` or `completed`.
   - If it gets stuck on `checking` or goes to `failed`, the TURN server
     isn't being reached — check your network/firewall allows UDP/TCP 443.
4. `connectionState: failed` will now also show a toast and auto-cleanup
   instead of silently hanging.
