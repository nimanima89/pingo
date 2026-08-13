import {createServer} from 'node:http';
import {resolve} from 'node:path';
import express from 'express';
import {Server as SocketServer} from 'socket.io';
import {z} from 'zod';
import {
  checkPassword, consumeEmailCode, createUser, findUserByEmail, issueEmailCode,
  publicUser, requireAuth, signToken, updateProfile, userFromToken
} from './auth.js';
import {
  chatMemberIds, chatMembers, createGroupChat, createMessage, findOrCreateDirectChat,
  isMember, leaveChat, listChats, listMessages, markRead, searchUsers
} from './chats.js';
import {mailEnabled, sendVerificationCode} from './mail.js';

const PORT = Number(process.env.PORT || 3000);
const app = express();

app.use(express.json());
app.use(express.static(resolve(import.meta.dirname, '../public')));

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const signupSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1).max(64),
  password: z.string().min(8).max(128)
});
const verifySchema = z.object({email: emailSchema, code: z.string().trim().length(6)});
const loginSchema = z.object({email: emailSchema, password: z.string().min(1).max(128)});
const messageSchema = z.object({chatId: z.number().int().positive(), text: z.string().trim().min(1).max(4096)});
const profileSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  avatar: z.string().trim().max(8).optional(),
  theme: z.enum(['light', 'dark']).optional()
});
const groupSchema = z.object({
  title: z.string().trim().min(1).max(64),
  memberIds: z.array(z.number().int().positive()).min(1).max(200)
});

function parse(schema, body, res) {
  const result = schema.safeParse(body);
  if(!result.success) {
    res.status(400).json({error: 'invalid_input', details: result.error.issues.map((i) => i.path.join('.') + ': ' + i.message)});
    return null;
  }

  return result.data;
}

app.post('/api/auth/signup', async(req, res) => {
  const data = parse(signupSchema, req.body, res);
  if(!data) return;

  const existing = findUserByEmail(data.email);
  if(existing?.verified) {
    return res.status(409).json({error: 'email_taken'});
  }

  const user = existing || createUser(data);
  const code = issueEmailCode(user.id);
  const {delivered} = await sendVerificationCode(user.email, code);
  res.json({email: user.email, emailDelivered: delivered});
});

app.post('/api/auth/verify', (req, res) => {
  const data = parse(verifySchema, req.body, res);
  if(!data) return;

  const user = findUserByEmail(data.email);
  if(!user) return res.status(404).json({error: 'unknown_email'});

  const result = consumeEmailCode(user.id, data.code);
  if(!result.ok) return res.status(400).json({error: result.error});

  const verified = findUserByEmail(data.email);
  res.json({token: signToken(verified), user: publicUser(verified)});
});

app.post('/api/auth/resend', async(req, res) => {
  const email = emailSchema.safeParse(req.body?.email);
  if(!email.success) return res.status(400).json({error: 'invalid_input'});

  const user = findUserByEmail(email.data);
  if(!user || user.verified) return res.status(400).json({error: 'not_pending'});

  const {delivered} = await sendVerificationCode(user.email, issueEmailCode(user.id));
  res.json({emailDelivered: delivered});
});

app.post('/api/auth/login', (req, res) => {
  const data = parse(loginSchema, req.body, res);
  if(!data) return;

  const user = findUserByEmail(data.email);
  if(!user || !checkPassword(user, data.password)) {
    return res.status(401).json({error: 'invalid_credentials'});
  }

  if(!user.verified) {
    return res.status(403).json({error: 'email_not_verified', email: user.email});
  }

  res.json({token: signToken(user), user: publicUser(user)});
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({user: publicUser(req.user), mailEnabled});
});

app.patch('/api/me', requireAuth, (req, res) => {
  const data = parse(profileSchema, req.body, res);
  if(!data) return;

  res.json({user: publicUser(updateProfile(req.user.id, data))});
});

app.get('/api/users', requireAuth, (req, res) => {
  const query = String(req.query.q || '').trim();
  res.json({users: query ? searchUsers(query, req.user.id) : []});
});

app.get('/api/chats', requireAuth, (req, res) => {
  res.json({chats: listChats(req.user.id)});
});

app.post('/api/chats', requireAuth, (req, res) => {
  const userId = Number(req.body?.userId);
  if(!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({error: 'invalid_input'});
  }

  const chatId = findOrCreateDirectChat(req.user.id, userId);
  res.json({chatId});
});

app.post('/api/chats/group', requireAuth, (req, res) => {
  const data = parse(groupSchema, req.body, res);
  if(!data) return;

  const chatId = createGroupChat({title: data.title, creatorId: req.user.id, memberIds: data.memberIds});
  if(!chatId) return res.status(400).json({error: 'invalid_members'});

  for(const memberId of chatMemberIds(chatId)) {
    io.to(`user:${memberId}`).emit('chat:new', {chatId});
  }

  res.json({chatId});
});

app.get('/api/chats/:id/members', requireAuth, (req, res) => {
  const chatId = Number(req.params.id);
  if(!isMember(chatId, req.user.id)) return res.status(404).json({error: 'not_found'});

  res.json({members: chatMembers(chatId)});
});

app.post('/api/chats/:id/leave', requireAuth, (req, res) => {
  const chatId = Number(req.params.id);
  if(!isMember(chatId, req.user.id)) return res.status(404).json({error: 'not_found'});

  leaveChat(chatId, req.user.id);
  res.json({ok: true});
});

app.get('/api/chats/:id/messages', requireAuth, (req, res) => {
  const chatId = Number(req.params.id);
  if(!isMember(chatId, req.user.id)) return res.status(404).json({error: 'not_found'});

  const beforeId = req.query.beforeId ? Number(req.query.beforeId) : undefined;
  res.json({messages: listMessages(chatId, {beforeId})});
});

app.post('/api/chats/:id/read', requireAuth, (req, res) => {
  const chatId = Number(req.params.id);
  if(!isMember(chatId, req.user.id)) return res.status(404).json({error: 'not_found'});

  markRead(chatId, req.user.id, Number(req.body?.messageId || 0));
  res.json({ok: true});
});

const server = createServer(app);
const io = new SocketServer(server);

io.use((socket, next) => {
  const user = userFromToken(socket.handshake.auth?.token);
  if(!user || !user.verified) return next(new Error('unauthorized'));

  socket.data.user = user;
  next();
});

io.on('connection', (socket) => {
  const user = socket.data.user;
  socket.join(`user:${user.id}`);

  socket.on('message:send', (payload, ack) => {
    const parsed = messageSchema.safeParse(payload);
    if(!parsed.success) return ack?.({error: 'invalid_input'});
    if(!isMember(parsed.data.chatId, user.id)) return ack?.({error: 'not_found'});

    const message = createMessage({chatId: parsed.data.chatId, senderId: user.id, text: parsed.data.text});
    for(const memberId of chatMemberIds(parsed.data.chatId)) {
      io.to(`user:${memberId}`).emit('message:new', message);
    }

    ack?.({message});
  });

  socket.on('typing', ({chatId}) => {
    if(!Number.isInteger(chatId) || !isMember(chatId, user.id)) return;

    for(const memberId of chatMemberIds(chatId)) {
      if(memberId !== user.id) {
        io.to(`user:${memberId}`).emit('typing', {chatId, userId: user.id, name: user.name});
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Pingo server listening on http://localhost:${server.address().port} (email delivery: ${mailEnabled ? 'SMTP' : 'console'})`);
});

export default server;
