import db from './db.js';

export function isMember(chatId, userId) {
  return Boolean(db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId));
}

export function chatMemberIds(chatId) {
  return db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId).map((r) => r.user_id);
}

export function findOrCreateDirectChat(userA, userB) {
  const existing = db.prepare(`
    SELECT a.chat_id AS id FROM chat_members a
    JOIN chat_members b ON a.chat_id = b.chat_id
    WHERE a.user_id = ? AND b.user_id = ?
      AND (SELECT COUNT(*) FROM chat_members m WHERE m.chat_id = a.chat_id) = 2
  `).get(userA, userB);

  if(existing) return existing.id;

  const create = db.transaction(() => {
    const info = db.prepare('INSERT INTO chats (created_at) VALUES (?)').run(Date.now());
    const chatId = Number(info.lastInsertRowid);
    const insert = db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)');
    insert.run(chatId, userA);
    if(userB !== userA) insert.run(chatId, userB);
    return chatId;
  });

  return create();
}

export function listChats(userId) {
  return db.prepare(`
    SELECT
      c.id,
      (SELECT json_group_array(json_object('id', u.id, 'name', u.name, 'email', u.email))
        FROM chat_members cm2 JOIN users u ON u.id = cm2.user_id
        WHERE cm2.chat_id = c.id AND cm2.user_id != ?) AS peers_json,
      (SELECT json_object('id', m.id, 'text', m.text, 'senderId', m.sender_id, 'createdAt', m.created_at)
        FROM messages m WHERE m.chat_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_json,
      (SELECT COUNT(*) FROM messages m
        WHERE m.chat_id = c.id AND m.id > cm.last_read_message_id AND m.sender_id != ?) AS unread
    FROM chats c
    JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = ?
    ORDER BY COALESCE((SELECT MAX(m.id) FROM messages m WHERE m.chat_id = c.id), 0) DESC
  `).all(userId, userId, userId).map((row) => ({
    id: row.id,
    peers: JSON.parse(row.peers_json || '[]'),
    lastMessage: row.last_json ? JSON.parse(row.last_json) : null,
    unread: row.unread
  }));
}

export function listMessages(chatId, {beforeId, limit = 50} = {}) {
  const rows = beforeId ?
    db.prepare('SELECT * FROM messages WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(chatId, beforeId, limit) :
    db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?').all(chatId, limit);

  return rows.reverse().map(serializeMessage);
}

export function createMessage({chatId, senderId, text}) {
  const info = db.prepare('INSERT INTO messages (chat_id, sender_id, text, created_at) VALUES (?, ?, ?, ?)')
    .run(chatId, senderId, text, Date.now());
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
  markRead(chatId, senderId, message.id);
  return serializeMessage(message);
}

export function markRead(chatId, userId, messageId) {
  db.prepare('UPDATE chat_members SET last_read_message_id = MAX(last_read_message_id, ?) WHERE chat_id = ? AND user_id = ?')
    .run(messageId, chatId, userId);
}

export function searchUsers(query, excludeUserId) {
  const like = `%${query}%`;
  return db.prepare(`
    SELECT id, name, email FROM users
    WHERE verified = 1 AND id != ? AND (name LIKE ? OR email LIKE ?)
    ORDER BY name LIMIT 20
  `).all(excludeUserId, like, like);
}

function serializeMessage(message) {
  return {
    id: message.id,
    chatId: message.chat_id,
    senderId: message.sender_id,
    text: message.text,
    createdAt: message.created_at
  };
}
