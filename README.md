# Pingo

Pingo is a standalone messenger: email sign-up, real-time 1:1 chats, and a yellow interface.
It runs on its own backend and is not connected to the Telegram network.

## Stack

| Layer | Technology |
|---|---|
| Server | Node 22, Express 5 |
| Realtime | Socket.IO |
| Storage | SQLite (better-sqlite3) |
| Auth | bcrypt password hashes + JWT, email verification codes |
| Client | Vanilla ES modules + CSS (no build step) |

## Run

```bash
npm install
npm start          # http://localhost:3000
npm test           # API + socket tests (node:test)
```

## Email delivery

Verification codes are printed to the server log when no SMTP server is configured, so sign-up
works out of the box locally:

```
[pingo:mail] verification code for you@example.com: 123456
```

To send real email, set the SMTP variables before starting:

```bash
SMTP_HOST=smtp.example.com SMTP_PORT=587 SMTP_USER=... SMTP_PASS=... \
SMTP_FROM='Pingo <no-reply@example.com>' npm start
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `PINGO_DB_PATH` | `data/pingo.db` | SQLite database file |
| `PINGO_JWT_SECRET` | random per boot | Set it to keep sessions valid across restarts |
| `SMTP_*` | unset | SMTP delivery (see above) |

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/signup` | Create an account, send a 6-digit code |
| `POST /api/auth/verify` | Confirm the code, return a JWT |
| `POST /api/auth/resend` | Re-send the code |
| `POST /api/auth/login` | Email + password login |
| `GET /api/me` | Current user |
| `GET /api/users?q=` | Find verified people by name or email |
| `GET`/`POST /api/chats` | List chats / open a direct chat |
| `GET /api/chats/:id/messages` | Message history (`?beforeId=` to page) |
| `POST /api/chats/:id/read` | Mark read up to a message |

Socket.IO events (JWT in `auth.token`): `message:send` (ack'd) and `typing` from the client,
`message:new` and `typing` to the client.

## Layout

```
server/   index.js (HTTP + socket), auth.js, chats.js, db.js, mail.js
public/   index.html, app.js, styles.css, assets/logo.svg
tests/    api.test.js
```
