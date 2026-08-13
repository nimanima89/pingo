import {randomInt, randomBytes} from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db from './db.js';

export const JWT_SECRET = process.env.PINGO_JWT_SECRET || randomBytes(32).toString('hex');
const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

export function publicUser(user) {
  return {id: user.id, email: user.email, name: user.name, verified: Boolean(user.verified)};
}

export function signToken(user) {
  return jwt.sign({sub: user.id, email: user.email}, JWT_SECRET, {expiresIn: '30d'});
}

export function userFromToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
  } catch {
    return null;
  }
}

export function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const user = header.startsWith('Bearer ') ? userFromToken(header.slice(7)) : null;

  if(!user || !user.verified) {
    return res.status(401).json({error: 'unauthorized'});
  }

  req.user = user;
  next();
}

export function findUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

export function createUser({email, name, password}) {
  const hash = bcrypt.hashSync(password, 12);
  const info = db.prepare(
    'INSERT INTO users (email, name, password_hash, verified, created_at) VALUES (?, ?, ?, 0, ?)'
  ).run(email, name, hash, Date.now());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

export function checkPassword(user, password) {
  return bcrypt.compareSync(password, user.password_hash);
}

export function issueEmailCode(userId) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  db.prepare('DELETE FROM email_codes WHERE user_id = ?').run(userId);
  db.prepare('INSERT INTO email_codes (user_id, code, expires_at) VALUES (?, ?, ?)')
    .run(userId, code, Date.now() + CODE_TTL_MS);
  return code;
}

export function consumeEmailCode(userId, code) {
  const row = db.prepare('SELECT * FROM email_codes WHERE user_id = ?').get(userId);
  if(!row) return {ok: false, error: 'no_code'};
  if(row.expires_at < Date.now()) {
    db.prepare('DELETE FROM email_codes WHERE id = ?').run(row.id);
    return {ok: false, error: 'code_expired'};
  }

  if(row.code !== code) {
    const attempts = row.attempts + 1;
    if(attempts >= MAX_CODE_ATTEMPTS) {
      db.prepare('DELETE FROM email_codes WHERE id = ?').run(row.id);
      return {ok: false, error: 'too_many_attempts'};
    }

    db.prepare('UPDATE email_codes SET attempts = ? WHERE id = ?').run(attempts, row.id);
    return {ok: false, error: 'invalid_code'};
  }

  db.prepare('DELETE FROM email_codes WHERE id = ?').run(row.id);
  db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(userId);
  return {ok: true};
}
