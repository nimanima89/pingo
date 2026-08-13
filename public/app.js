const TOKEN_KEY = 'pingo:token';

const el = (id) => document.getElementById(id);
const state = {
  token: localStorage.getItem(TOKEN_KEY),
  me: null,
  chats: [],
  activeChatId: null,
  activePeer: null,
  socket: null,
  pendingEmail: null,
  typingTimer: null
};

async function api(path, {method = 'GET', body} = {}) {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? {Authorization: `Bearer ${state.token}`} : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await response.json().catch(() => ({}));
  if(!response.ok) throw Object.assign(new Error(data.error || 'request_failed'), {data, status: response.status});
  return data;
}

const ERRORS = {
  email_taken: 'That email already has a Pingo account — log in instead.',
  invalid_credentials: 'Wrong email or password.',
  invalid_code: 'That code is not right. Try again.',
  code_expired: 'The code expired. Send a new one.',
  too_many_attempts: 'Too many wrong codes. Request a new one.',
  no_code: 'No pending code — sign up again.',
  email_not_verified: 'Verify your email first.',
  invalid_input: 'Please check the form fields.'
};

function showError(error) {
  const node = el('auth-error');
  const message = ERRORS[error?.message] || error?.message || '';
  node.textContent = message;
  node.classList.toggle('hidden', !message);
}

function showAuthView(view, {email} = {}) {
  for(const name of ['signup', 'verify', 'login']) {
    el(`form-${name}`).classList.toggle('hidden', name !== view);
  }

  const titles = {
    signup: ['Sign up for Pingo', 'Create an account with your email address.'],
    verify: ['Check your email', ''],
    login: ['Log in to Pingo', 'Welcome back.']
  };
  el('auth-title').textContent = titles[view][0];
  el('auth-subtitle').textContent = titles[view][1];
  if(view === 'verify') el('verify-hint').textContent = `We sent a 6-digit code to ${email}.`;
  showError(null);
}

let toastTimer;
function showToast(error) {
  const node = el('toast');
  node.textContent = ERRORS[error?.message] || error?.message || 'Something went wrong.';
  node.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), 4000);
}

function guard(action) {
  return Promise.resolve().then(action).catch(showToast);
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('');
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}

function peerOf(chat) {
  return chat.peers[0] || {id: state.me.id, name: `${state.me.name} (you)`, email: state.me.email};
}

function renderChats() {
  const list = el('chats');
  list.replaceChildren(...state.chats.map((chat) => {
    const peer = peerOf(chat);
    const item = document.createElement('li');
    item.className = 'row' + (chat.id === state.activeChatId ? ' active' : '');
    item.innerHTML = `
      <div class="avatar"></div>
      <div>
        <div class="row-title"></div>
        <div class="row-subtitle"></div>
      </div>
      <span class="badge hidden"></span>
    `;
    item.querySelector('.avatar').textContent = initials(peer.name);
    item.querySelector('.row-title').textContent = peer.name;
    item.querySelector('.row-subtitle').textContent = chat.lastMessage ?
      (chat.lastMessage.senderId === state.me.id ? 'You: ' : '') + chat.lastMessage.text :
      'No messages yet';

    if(chat.unread > 0 && chat.id !== state.activeChatId) {
      const badge = item.querySelector('.badge');
      badge.textContent = chat.unread;
      badge.classList.remove('hidden');
    }

    item.addEventListener('click', () => guard(() => openChat(chat.id, peer)));
    return item;
  }));
}

function renderMessages(messages) {
  const container = el('messages');
  container.replaceChildren(...messages.map(messageNode));
  container.scrollTop = container.scrollHeight;
}

function messageNode(message) {
  const bubble = document.createElement('div');
  bubble.className = 'bubble' + (message.senderId === state.me.id ? ' out' : '');
  const text = document.createElement('span');
  text.textContent = message.text;
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = formatTime(message.createdAt);
  bubble.append(text, time);
  return bubble;
}

async function refreshChats() {
  const {chats} = await api('/chats');
  state.chats = chats;
  renderChats();
}

async function openChat(chatId, peer) {
  state.activeChatId = chatId;
  state.activePeer = peer;
  el('empty').classList.add('hidden');
  el('chat-header').classList.remove('hidden');
  el('composer').classList.remove('hidden');
  el('messenger').classList.add('chat-open');
  el('peer-avatar').textContent = initials(peer.name);
  el('peer-name').textContent = peer.name;
  el('peer-status').textContent = peer.email;
  el('results').classList.add('hidden');
  el('search').value = '';

  const {messages} = await api(`/chats/${chatId}/messages`);
  renderMessages(messages);
  const lastId = messages.at(-1)?.id || 0;
  await api(`/chats/${chatId}/read`, {method: 'POST', body: {messageId: lastId}});
  await refreshChats();
  el('composer-input').focus();
}

function closeChat() {
  state.activeChatId = null;
  state.activePeer = null;
  el('messenger').classList.remove('chat-open');
  el('chat-header').classList.add('hidden');
  el('composer').classList.add('hidden');
  el('messages').replaceChildren();
  el('empty').classList.remove('hidden');
  renderChats();
}

async function startChatWith(user) {
  const {chatId} = await api('/chats', {method: 'POST', body: {userId: user.id}});
  await refreshChats();
  await openChat(chatId, user);
}

function connectSocket() {
  state.socket?.disconnect();
  state.socket = io({auth: {token: state.token}});

  state.socket.on('message:new', (message) => guard(async() => {
    if(message.chatId === state.activeChatId) {
      const container = el('messages');
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
      container.append(messageNode(message));
      if(atBottom) container.scrollTop = container.scrollHeight;
      await api(`/chats/${message.chatId}/read`, {method: 'POST', body: {messageId: message.id}});
    }

    await refreshChats();
  }));

  state.socket.on('typing', ({chatId, name}) => {
    if(chatId !== state.activeChatId) return;

    el('peer-status').textContent = `${name} is typing…`;
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => {
      el('peer-status').textContent = state.activePeer?.email || '';
    }, 2000);
  });
}

async function enterMessenger() {
  const {user} = await api('/me');
  state.me = user;
  el('auth').classList.add('hidden');
  el('messenger').classList.remove('hidden');
  el('me').textContent = `${user.name} · ${user.email}`;
  connectSocket();
  await refreshChats();
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  state.token = null;
  state.socket?.disconnect();
  location.reload();
}

function bindAuth() {
  for(const button of document.querySelectorAll('[data-view]')) {
    button.addEventListener('click', () => showAuthView(button.dataset.view));
  }

  el('form-signup').addEventListener('submit', async(event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const email = String(form.get('email')).trim().toLowerCase();
    await withPending(event.target, async() => {
      await api('/auth/signup', {
        method: 'POST',
        body: {email, name: String(form.get('name')), password: String(form.get('password'))}
      });
      state.pendingEmail = email;
      showAuthView('verify', {email});
    });
  });

  el('form-verify').addEventListener('submit', async(event) => {
    event.preventDefault();
    const code = String(new FormData(event.target).get('code')).trim();
    await withPending(event.target, async() => {
      const {token} = await api('/auth/verify', {method: 'POST', body: {email: state.pendingEmail, code}});
      state.token = token;
      localStorage.setItem(TOKEN_KEY, token);
      await enterMessenger();
    });
  });

  el('resend').addEventListener('click', async() => {
    try {
      await api('/auth/resend', {method: 'POST', body: {email: state.pendingEmail}});
      showError(null);
    } catch(error) {
      showError(error);
    }
  });

  el('form-login').addEventListener('submit', async(event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const email = String(form.get('email')).trim().toLowerCase();
    await withPending(event.target, async() => {
      try {
        const {token} = await api('/auth/login', {
          method: 'POST',
          body: {email, password: String(form.get('password'))}
        });
        state.token = token;
        localStorage.setItem(TOKEN_KEY, token);
        await enterMessenger();
      } catch(error) {
        if(error.message === 'email_not_verified') {
          state.pendingEmail = email;
          await api('/auth/resend', {method: 'POST', body: {email}});
          showAuthView('verify', {email});
          return;
        }

        throw error;
      }
    });
  });
}

async function withPending(form, action) {
  const button = form.querySelector('button.primary');
  button.disabled = true;
  try {
    showError(null);
    await action();
  } catch(error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
}

function bindMessenger() {
  el('logout').addEventListener('click', logout);
  el('back').addEventListener('click', closeChat);

  let searchTimer;
  el('search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    const query = event.target.value.trim();
    if(!query) {
      el('results').classList.add('hidden');
      return;
    }

    searchTimer = setTimeout(async() => {
      const {users} = await api(`/users?q=${encodeURIComponent(query)}`);
      const list = el('results');
      list.classList.remove('hidden');
      list.replaceChildren(...(users.length ? users.map((user) => {
        const item = document.createElement('li');
        item.className = 'row';
        item.innerHTML = '<div class="avatar"></div><div><div class="row-title"></div><div class="row-subtitle"></div></div><span></span>';
        item.querySelector('.avatar').textContent = initials(user.name);
        item.querySelector('.row-title').textContent = user.name;
        item.querySelector('.row-subtitle').textContent = user.email;
        item.addEventListener('click', () => guard(() => startChatWith(user)));
        return item;
      }) : [emptyResult()]));
    }, 250);
  });

  el('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = el('composer-input');
    const text = input.value.trim();
    if(!text || !state.activeChatId) return;

    input.value = '';
    state.socket.emit('message:send', {chatId: state.activeChatId, text}, (response) => {
      if(response?.error) showToast(new Error(response.error));
    });
  });

  el('composer-input').addEventListener('input', () => {
    if(state.activeChatId) state.socket.emit('typing', {chatId: state.activeChatId});
  });
}

function emptyResult() {
  const item = document.createElement('li');
  item.className = 'row';
  item.style.cursor = 'default';
  item.innerHTML = '<div></div><div class="row-subtitle">No people found.</div><span></span>';
  return item;
}

bindAuth();
bindMessenger();
showAuthView('signup');

if(state.token) {
  enterMessenger().catch(() => {
    localStorage.removeItem(TOKEN_KEY);
    state.token = null;
  });
}
