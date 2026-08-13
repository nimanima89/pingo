---
name: testing-pingo
description: How to run and end-to-end test the Pingo standalone messenger (Express 5 + Socket.IO + SQLite backend in server/, vanilla ESM frontend in public/) locally, including email-code signup, two-user realtime testing, and socket-level adversarial checks.
---

# Testing Pingo locally

## Run the server
```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"   # Node 22 is required (better-sqlite3 prebuilds)
cd /home/ubuntu/repos/pingo
npm install
rm -f data/pingo.db*                                # optional: clean DB for a deterministic run
PINGO_JWT_SECRET=devsecret PORT=3000 node server/index.js > /tmp/pingo-test.log 2>&1 &
```
- App: http://localhost:3000 . Unit/API tests: `npm test` (node:test, spins up its own server).
- Override the DB path with `PINGO_DB_PATH` if you want to keep the dev DB intact.
- If `GET /` returns 404, an old `node` process from a different checkout is holding port 3000.
  Find it with `ss -ltnp | grep 3000`, kill it, and restart from this repo — `express.static` resolves
  `../public` relative to `server/index.js`, so a stale path serves nothing.

## Getting the email verification code (no SMTP configured)
Codes are printed to the server log, never emailed:
```bash
grep 'verification code for <email>' /tmp/pingo-test.log | tail -1
```
Code TTL is 15 min and there are 5 attempts (`server/auth.js`); after the 5th wrong code the row is
deleted, so subsequent attempts return `no_code` and the user must use "Send the code again".

## Seeding test users fast (do this in setup, not on camera)
Signing up through the UI for every user is slow. Create secondary users over the API:
```bash
curl -s -X POST localhost:3000/api/auth/signup -H 'content-type: application/json' \
  -d '{"email":"maya.tester@pingo.app","name":"Maya Tester","password":"pingo12345"}'
CODE=$(grep -o 'maya.tester@pingo.app: [0-9]*' /tmp/pingo-test.log | tail -1 | grep -o '[0-9]*$')
curl -s -X POST localhost:3000/api/auth/verify -H 'content-type: application/json' \
  -d "{\"email\":\"maya.tester@pingo.app\",\"code\":\"$CODE\"}"      # returns {token, user}
```
Leave one user unverified on purpose to test that login is blocked for unverified accounts
(expected: login returns 403 `email_not_verified` and the UI shows the "Check your email" screen).

## Two-user realtime testing in the browser
- Use one normal Chrome window + one incognito window (separate `localStorage`, so separate sessions).
- Tile them side by side so both are visible in one recording:
  ```bash
  wmctrl -r "Pingo - Google Chrome for Testing" -e 0,0,0,800,1180
  wmctrl -r "New Incognito Tab - Google Chrome for Testing" -e 0,800,0,800,1180
  ```
- KDE may swallow the first click on an unfocused window: click the target window's title bar
  first, then interact. If a click seems to do nothing, this is the most likely cause.
- Screenshot coordinates are scaled (e.g. 1024x768 tool space over a 1600x1200 display). Sidebar rows
  are only ~64 CSS px tall, so aim for the row's vertical centre; verify with
  `document.elementFromPoint(...)` / a temporary `mousemove` logger if clicks land on borders.
- The typing indicator replaces the peer's email in the chat header with "<Name> is typing…" for ~2s.
  Just type (do not send) in one window and screenshot the other immediately.

## Known bug class: silent failures from unhandled promise rejections
`app.js` handlers are `async` with no `try/catch` in some paths (`startChatWith` → `openChat`), so a
runtime error produces NO visible UI change and NO visible error — the UI just looks inert. If a click
appears dead, install listeners before clicking:
```js
window.addEventListener('unhandledrejection', (e) => console.log('UNHANDLED REJECTION', e.reason?.message));
window.addEventListener('error', (e) => console.log('WINDOW ERROR', e.message));
```
Concretely, `openChat` does `el('empty').classList.add('hidden')`, but `renderMessages` uses
`container.replaceChildren(...)` on `#messages`, which permanently removes the `#empty` node. So the
FIRST chat open per page load works and every later chat open (sidebar row or search result) throws
`Cannot read properties of null (reading 'classList')` — chat switching stays broken until reload.
Always test opening a SECOND chat, not just the first one; a single-chat happy path hides this.

## Adversarial checks that are cheaper over the API/socket than the UI
Message length/emptiness and membership checks are enforced by zod + `isMember` on the socket, so a
small `socket.io-client` script beats typing 5000 chars into the composer:
```js
import {io} from '/home/ubuntu/repos/pingo/node_modules/socket.io-client/build/esm/index.js';
const socket = io('http://localhost:3000', {auth: {token}});
socket.emit('message:send', {chatId: 1, text: 'a'.repeat(4097)}, console.log); // {error:'invalid_input'}
```
Expected: 4096 chars ok, 4097+/empty/whitespace → `invalid_input`; non-member or unknown `chatId` →
`not_found`; a garbage token fails the handshake with `unauthorized`.
`GET /api/chats/:id/messages` → 200 for a member, 404 for a non-member, 401 with no token.

## Devin Secrets Needed
None — everything runs locally with `PINGO_JWT_SECRET=devsecret`; no SMTP credentials are required
because verification codes go to the server log.
