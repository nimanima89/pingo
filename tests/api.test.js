import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';

process.env.PINGO_DB_PATH = join(mkdtempSync(join(tmpdir(), 'pingo-test-')), 'test.db');
process.env.PINGO_JWT_SECRET = 'test-secret';
process.env.PORT = '0';

const {default: server} = await import('../server/index.js');

let base;

before(async() => {
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function call(path, {method = 'GET', body, token} = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})},
    body: body ? JSON.stringify(body) : undefined
  });
  return {status: response.status, body: await response.json().catch(() => ({}))};
}

async function signup(email, name) {
  const signupResult = await call('/api/auth/signup', {method: 'POST', body: {email, name, password: 'pingo12345'}});
  assert.equal(signupResult.status, 200);
  const {code} = await import('../server/db.js').then(({default: db}) => {
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    return db.prepare('SELECT code FROM email_codes WHERE user_id = ?').get(user.id);
  });
  const verified = await call('/api/auth/verify', {method: 'POST', body: {email, code}});
  assert.equal(verified.status, 200);
  return verified.body;
}

test('rejects weak signup input', async() => {
  const result = await call('/api/auth/signup', {method: 'POST', body: {email: 'nope', name: '', password: 'short'}});
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'invalid_input');
});

test('signs up, verifies email and logs in', async() => {
  const {token, user} = await signup('alice@pingo.test', 'Alice');
  assert.ok(token);
  assert.equal(user.verified, true);

  const me = await call('/api/me', {token});
  assert.equal(me.body.user.email, 'alice@pingo.test');

  const login = await call('/api/auth/login', {method: 'POST', body: {email: 'alice@pingo.test', password: 'pingo12345'}});
  assert.equal(login.status, 200);

  const wrong = await call('/api/auth/login', {method: 'POST', body: {email: 'alice@pingo.test', password: 'nope12345'}});
  assert.equal(wrong.status, 401);

  const duplicate = await call('/api/auth/signup', {method: 'POST', body: {email: 'alice@pingo.test', name: 'Alice', password: 'pingo12345'}});
  assert.equal(duplicate.status, 409);
});

test('rejects a wrong verification code', async() => {
  await call('/api/auth/signup', {method: 'POST', body: {email: 'pending@pingo.test', name: 'Pending', password: 'pingo12345'}});
  const result = await call('/api/auth/verify', {method: 'POST', body: {email: 'pending@pingo.test', code: '000000'}});
  assert.equal(result.status, 400);
  assert.match(result.body.error, /invalid_code|too_many_attempts/);
});

test('unauthenticated requests are rejected', async() => {
  assert.equal((await call('/api/chats')).status, 401);
  assert.equal((await call('/api/me', {token: 'garbage'})).status, 401);
});

test('creates a direct chat and finds the peer by email', async() => {
  const alice = await signup('a2@pingo.test', 'Alice Two');
  const bob = await signup('b2@pingo.test', 'Bob Two');

  const found = await call('/api/users?q=b2@pingo.test', {token: alice.token});
  assert.equal(found.body.users[0].id, bob.user.id);

  const chat = await call('/api/chats', {method: 'POST', body: {userId: bob.user.id}, token: alice.token});
  assert.ok(chat.body.chatId);

  const again = await call('/api/chats', {method: 'POST', body: {userId: bob.user.id}, token: alice.token});
  assert.equal(again.body.chatId, chat.body.chatId, 'direct chats are deduplicated');

  const bobChats = await call('/api/chats', {token: bob.token});
  assert.equal(bobChats.body.chats[0].peers[0].email, 'a2@pingo.test');

  const outsider = await signup('c2@pingo.test', 'Carol');
  const denied = await call(`/api/chats/${chat.body.chatId}/messages`, {token: outsider.token});
  assert.equal(denied.status, 404);
});

test('delivers messages over the socket to both participants', async() => {
  const {io} = await import('socket.io-client').catch(() => ({io: null}));
  if(!io) return; // socket.io-client is optional in this environment

  const alice = await signup('a3@pingo.test', 'Alice Three');
  const bob = await signup('b3@pingo.test', 'Bob Three');
  const {body: {chatId}} = await call('/api/chats', {method: 'POST', body: {userId: bob.user.id}, token: alice.token});

  const aliceSocket = io(base, {auth: {token: alice.token}});
  const bobSocket = io(base, {auth: {token: bob.token}});
  const received = new Promise((resolve) => bobSocket.on('message:new', resolve));

  await new Promise((resolve) => aliceSocket.on('connect', resolve));
  await new Promise((resolve) => bobSocket.on('connect', resolve));
  aliceSocket.emit('message:send', {chatId, text: 'hey bob'});

  const message = await received;
  assert.equal(message.text, 'hey bob');

  const history = await call(`/api/chats/${chatId}/messages`, {token: bob.token});
  assert.equal(history.body.messages.at(-1).text, 'hey bob');

  const chats = await call('/api/chats', {token: bob.token});
  assert.equal(chats.body.chats[0].unread, 1);

  aliceSocket.close();
  bobSocket.close();
});
