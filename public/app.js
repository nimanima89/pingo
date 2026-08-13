const TOKEN_KEY = 'pingo:token';
const THEME_KEY = 'pingo:theme';
const AVATARS = ['🐣', '🐝', '🦊', '🐼', '🐨', '🦉', '🐙', '🌻', '🍋', '⚡️', '🎧', '🚀', '🎨', '🌙', '🔥', '🧩'];

const el = (id) => document.getElementById(id);
const state = {
  token: localStorage.getItem(TOKEN_KEY),
  me: null,
  chats: [],
  activeChatId: null,
  activeChat: null,
  activePeer: null,
  socket: null,
  pendingEmail: null,
  typingTimer: null,
  groupPicks: new Map(),
  draftAvatar: ''
};

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  localStorage.setItem(THEME_KEY, theme);
}

applyTheme(localStorage.getItem(THEME_KEY) || 'light');

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

function avatarOf(entity) {
  return entity?.avatar || initials(entity?.name || '?');
}

function chatTitle(chat) {
  return chat.type === 'group' ? chat.title : peerOf(chat).name;
}

function chatSubtitle(chat) {
  return chat.type === 'group' ?
    `${chat.peers.length + 1} members` :
    peerOf(chat).email;
}

function chatAvatar(chat) {
  return chat.type === 'group' ? '👥' : avatarOf(peerOf(chat));
}

function openModal(id) {
  el(id).classList.remove('hidden');
}

function closeModal(id) {
  el(id).classList.add('hidden');
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
    item.querySelector('.avatar').textContent = chatAvatar(chat);
    item.querySelector('.row-title').textContent = chatTitle(chat);
    item.querySelector('.row-subtitle').textContent = chat.lastMessage ?
      (chat.lastMessage.senderId === state.me.id ? 'You: ' : '') + chat.lastMessage.text :
      'No messages yet';

    if(chat.unread > 0 && chat.id !== state.activeChatId) {
      const badge = item.querySelector('.badge');
      badge.textContent = chat.unread;
      badge.classList.remove('hidden');
    }

    item.addEventListener('click', () => guard(() => openChat(chat.id, peerOf(chat))));
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
  const own = message.senderId === state.me.id;
  bubble.className = 'bubble' + (own ? ' out' : '');

  if(!own && state.activeChat?.type === 'group') {
    const author = document.createElement('span');
    author.className = 'author';
    author.textContent = `${message.senderAvatar || ''} ${message.senderName || ''}`.trim();
    bubble.append(author);
  }

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
  const chat = state.chats.find((entry) => entry.id === chatId);
  state.activeChatId = chatId;
  state.activeChat = chat || null;
  state.activePeer = peer;
  el('empty').classList.add('hidden');
  el('chat-header').classList.remove('hidden');
  el('composer').classList.remove('hidden');
  el('messenger').classList.add('chat-open');
  el('peer-avatar').textContent = chat ? chatAvatar(chat) : avatarOf(peer);
  el('peer-name').textContent = chat ? chatTitle(chat) : peer.name;
  el('peer-status').textContent = chat ? chatSubtitle(chat) : peer.email;
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
  state.activeChat = null;
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

  state.socket.on('chat:new', () => guard(refreshChats));

  state.socket.on('typing', ({chatId, name}) => {
    if(chatId !== state.activeChatId) return;

    el('peer-status').textContent = `${name} is typing…`;
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => {
      el('peer-status').textContent = state.activeChat ? chatSubtitle(state.activeChat) : (state.activePeer?.email || '');
    }, 2000);
  });
}

async function enterMessenger() {
  const {user} = await api('/me');
  state.me = user;
  el('auth').classList.add('hidden');
  el('messenger').classList.remove('hidden');
  el('me').textContent = `${user.name} · ${user.email}`;
  el('me-avatar').textContent = avatarOf(user);
  applyTheme(user.theme);
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

function renderAvatarPicker() {
  const picker = el('avatar-picker');
  picker.replaceChildren(...AVATARS.map((emoji) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'avatar-option' + (emoji === state.draftAvatar ? ' selected' : '');
    option.textContent = emoji;
    option.addEventListener('click', () => {
      state.draftAvatar = state.draftAvatar === emoji ? '' : emoji;
      renderAvatarPicker();
    });
    return option;
  }));
}

function renderThemePicker(theme) {
  for(const button of document.querySelectorAll('.theme-option')) {
    button.classList.toggle('selected', button.dataset.theme === theme);
  }
}

function openSettings() {
  state.draftAvatar = state.me.avatar || '';
  el('settings-name').value = state.me.name;
  renderAvatarPicker();
  renderThemePicker(document.documentElement.dataset.theme);
  openModal('settings');
}

function renderGroupPicks() {
  const container = el('group-selected');
  container.replaceChildren(...[...state.groupPicks.values()].map((user) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = `${avatarOf(user)} ${user.name} ×`;
    chip.addEventListener('click', () => {
      state.groupPicks.delete(user.id);
      renderGroupPicks();
    });
    return chip;
  }));
}

function bindSettings() {
  el('open-settings').addEventListener('click', openSettings);

  for(const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => closeModal(button.dataset.close));
  }

  for(const button of document.querySelectorAll('.theme-option')) {
    button.addEventListener('click', () => {
      applyTheme(button.dataset.theme);
      renderThemePicker(button.dataset.theme);
    });
  }

  el('form-settings').addEventListener('submit', (event) => {
    event.preventDefault();
    guard(async() => {
      const {user} = await api('/me', {
        method: 'PATCH',
        body: {
          name: el('settings-name').value.trim(),
          avatar: state.draftAvatar,
          theme: document.documentElement.dataset.theme
        }
      });
      state.me = user;
      el('me').textContent = `${user.name} · ${user.email}`;
      el('me-avatar').textContent = avatarOf(user);
      closeModal('settings');
      await refreshChats();
    });
  });
}

function bindGroups() {
  el('new-group').addEventListener('click', () => {
    state.groupPicks.clear();
    el('group-title').value = '';
    el('group-search').value = '';
    el('group-results').replaceChildren();
    renderGroupPicks();
    openModal('group');
  });

  let groupTimer;
  el('group-search').addEventListener('input', (event) => {
    clearTimeout(groupTimer);
    const query = event.target.value.trim();
    if(!query) return el('group-results').replaceChildren();

    groupTimer = setTimeout(() => guard(async() => {
      const {users} = await api(`/users?q=${encodeURIComponent(query)}`);
      el('group-results').replaceChildren(...(users.length ? users.map((user) => {
        const item = document.createElement('li');
        item.className = 'row';
        item.innerHTML = '<div class="avatar"></div><div><div class="row-title"></div><div class="row-subtitle"></div></div><span></span>';
        item.querySelector('.avatar').textContent = avatarOf(user);
        item.querySelector('.row-title').textContent = user.name;
        item.querySelector('.row-subtitle').textContent = user.email;
        item.addEventListener('click', () => {
          state.groupPicks.set(user.id, user);
          renderGroupPicks();
        });
        return item;
      }) : [emptyResult()]));
    }), 250);
  });

  el('form-group').addEventListener('submit', (event) => {
    event.preventDefault();
    guard(async() => {
      const title = el('group-title').value.trim();
      const memberIds = [...state.groupPicks.keys()];
      if(!title || !memberIds.length) throw new Error('Add a name and at least one member.');

      const {chatId} = await api('/chats/group', {method: 'POST', body: {title, memberIds}});
      closeModal('group');
      await refreshChats();
      await openChat(chatId, null);
    });
  });
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
        item.querySelector('.avatar').textContent = avatarOf(user);
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
bindSettings();
bindGroups();
showAuthView('signup');

if(state.token) {
  enterMessenger().catch(() => {
    localStorage.removeItem(TOKEN_KEY);
    state.token = null;
  });
}
