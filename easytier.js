(function(){
'use strict';

const CONFIG = {
  host: 'peerjs.92k.de', port: 443, secure: true, path: '/',
  config: { iceServers: [{urls:'stun:stun.l.google.com:19302'}] },
  debug: 1
};

const CONST = {
  MAX_PEERS: 8, MIN_PEERS: 4, PEX_INTERVAL: 10000, TTL: 16, SYNC_LIMIT: 100
};

const db = {
  _db: null,
  async init() {
    return new Promise(r => {
      const req = indexedDB.open('P1_DB', 2);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('msgs')) {
          const store = d.createObjectStore('msgs', { keyPath: 'id' });
          store.createIndex('ts', 'ts');
        }
        if (!d.objectStoreNames.contains('pending')) {
          d.createObjectStore('pending', { keyPath: 'id' });
        }
      };
      req.onsuccess = e => { this._db = e.target.result; r(); };
      req.onerror = () => r();
    });
  },
  async saveMsg(msg) {
    if (!this._db) return;
    const tx = this._db.transaction(['msgs'], 'readwrite');
    tx.objectStore('msgs').put(msg);
  },
  async getRecent(limit, target='all', beforeTs = Date.now()) {
    if (!this._db) return [];
    return new Promise(resolve => {
      const tx  = this._db.transaction(['msgs'], 'readonly');
      // 允许 beforeTs=Infinity 时加载最新，避免对方时钟过快导致消息遗漏
      const range = (beforeTs === Infinity) ? null : IDBKeyRange.upperBound(beforeTs, true);
      const req  = tx.objectStore('msgs').index('ts').openCursor(range, 'prev');
      const res  = [];
      req.onsuccess = e => {
        const cursor = e.target.result;
        if (cursor && res.length < limit) {
          const m = cursor.value;
          const isPublic  = target === 'all' && m.target === 'all';
          const isPrivate = target !== 'all' && m.target !== 'all' &&
                            (m.target === target || m.senderId === target);
          if (isPublic || isPrivate) res.unshift(m);
          cursor.continue();
        } else {
          resolve(res);
        }
      };
    });
  },
  async addPending(msg) {
    if (!this._db) return;
    const tx = this._db.transaction(['pending'], 'readwrite');
    tx.objectStore('pending').put(msg);
  },
  async getPending() {
    if (!this._db) return [];
    return new Promise(r => {
      const tx  = this._db.transaction(['pending'], 'readonly');
      const req = tx.objectStore('pending').getAll();
      req.onsuccess = () => r(req.result);
    });
  },
  async removePending(id) {
    if (!this._db) return;
    const tx = this._db.transaction(['pending'], 'readwrite');
    tx.objectStore('pending').delete(id);
  }
};

const state = {
  myId:  localStorage.getItem('p1_my_id') ||
        ('u_' + Math.random().toString(36).substr(2, 9)),
  myName: localStorage.getItem('nickname') ||
        ('用户' + Math.floor(Math.random() * 1000)),
  peer: null,
  conns: {},
  contacts: JSON.parse(localStorage.getItem('p1_contacts') || '{}'),
  isHub: false,
  roomId: '',
  activeChat: 'all',
  activeChatName: '公共频道',
  unread: JSON.parse(localStorage.getItem('p1_unread') || '{}'),
  seenMsgs: new Set(),
  latestTs: 0,
  // Infinity 配合 getRecent 的 range=null，可以加载所有历史（含“未来时间”）
  oldestTs: Infinity,
  loading: false
};

const logSystem = {
  lastLog: null,
  count: 1,
  add(text) {
    const msg = `[${new Date().toLocaleTimeString()}] ${text}`;
    console.log(msg);
    const el = document.getElementById('logContent');
    if (!el) return;
    if (this.lastLog === text) {
      this.count++;
      if (el.lastChild) el.lastChild.innerText = `${msg} (x${this.count})`;
    } else {
      this.count   = 1;
      this.lastLog = text;
      const div    = document.createElement('div');
      div.innerText           = msg;
      div.style.borderBottom  = '1px solid #333';
      el.appendChild(div);
      if (el.children.length > 100) el.removeChild(el.firstChild);
      el.scrollTop = el.scrollHeight;
    }
  }
};

const util = {
  log:  (s) => logSystem.add(s),
  uuid: () => Math.random().toString(36).substr(2, 9) + Date.now().toString(36),

  // 正确 HTML 转义，避免 XSS
  escape(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#039;');
  },

  // 用户头像颜色哈希（现在只用于你自己大头像，列表和消息里不用）
  colorHash(str) {
    let hash = 0;
    str = String(str || '');
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
    return '#' + '000000'.substring(0, 6 - c.length) + c;
  }
};

const core = {
  async init() {
    if (typeof Peer === 'undefined') {
      console.error('PeerJS missing');
      return;
    }
    localStorage.setItem('p1_my_id', state.myId);

    await db.init();
    if (window.ui) window.ui.init();
    this.loadHistory(20);
    this.startPeer();

    setInterval(() => {
      this.cleanup();
      const roomId = 'p1-room-' + Math.floor(Date.now() / 3600000);
      state.roomId = roomId;

      if (!state.isHub) {
        const hubConn = state.conns[roomId];
        if (!hubConn || !hubConn.open) this.connectTo(roomId);
      }

      Object.values(state.contacts).forEach(c => {
        if (c.lastTry && Date.now() - c.lastTry < 10000) return;
        if (c.id &&
            c.id !== state.myId &&
            (!state.conns[c.id] || !state.conns[c.id].open)) {
          this.connectTo(c.id);
          c.lastTry = Date.now();
        }
      });

      this.sendPing();
      this.retryPending();
      this.exchange();
    }, 5000);
  },

  startPeer() {
    if (state.peer && !state.peer.destroyed) return;
    try {
      const p = new Peer(state.myId, CONFIG);
      p.on('open', id => {
        state.myId = id;
        state.peer = p;
        util.log(`✅ 上线: ${id}`);
        if (window.ui) window.ui.updateSelf();
        setTimeout(() => {
          if (state.roomId) this.connectTo(state.roomId);
        }, 500);
      });

      p.on('error', err => {
        util.log(`PeerErr: ${err.type}`);
        if (err.type === 'peer-unavailable' &&
            typeof err.message === 'string' &&
            err.message.indexOf('room') !== -1) {
          if (!state.isHub) {
            util.log('🚨 尝试上位...');
            state.isHub = true;
            state.peer.destroy();
            setTimeout(() => {
              const p2 = new Peer(state.roomId, CONFIG);
              p2.on('open', () => {
                state.peer = p2;
                state.myId = state.roomId;
                util.log('👑 成为房主');
                if (window.ui) window.ui.updateSelf();
              });
              p2.on('error', e => {
                if (e.type === 'unavailable-id') {
                  state.isHub = false;
                  setTimeout(() => this.startPeer(), 1000);
                }
              });
              p2.on('connection', c => this.setupConn(c));
            }, 500);
          }
        }
      });

      p.on('connection', conn => this.setupConn(conn));
    } catch(e) {
      util.log(`Fatal: ${e}`);
    }
  },

  connectTo(id) {
    if (!id || id === state.myId) return;
    if (!state.peer || state.peer.destroyed) return;
    if (state.conns[id] && state.conns[id].open) return;
    if (state.conns[id] &&
        Date.now() - (state.conns[id].created || 0) < 5000) return;
    try {
      const conn = state.peer.connect(id, {reliable: true});
      conn.created = Date.now();
      state.conns[id] = conn;
      this.setupConn(conn);
    } catch(e) {
      // 忽略瞬时错误
    }
  },

  setupConn(conn) {
    conn.on('open', () => {
      state.conns[conn.peer] = conn;
      conn.send({t: 'HELLO', n: state.myName, id: state.myId});
      this.exchange();
      this.retryPending();
      if (window.ui) window.ui.renderList();
    });
    conn.on('data', d => this.handleData(d, conn));
    const onGone = () => {
      delete state.conns[conn.peer];
      if (window.ui) window.ui.renderList();
    };
    conn.on('close', onGone);
    conn.on('error', onGone);
  },

  async handleData(d, conn) {
    if (!d || !d.t) return;

    if (d.t === 'PING') {
      conn.send({t: 'PONG'});
      return;
    }
    if (d.t === 'PONG') return;

    if (d.t === 'HELLO') {
      conn.label = d.n;
      state.contacts[d.id] = {id: d.id, n: d.n, t: Date.now()};
      if (d.id === state.roomId) {
        state.contacts['房主'] = {
          id: state.roomId, t: Date.now(), n: '房主'
        };
        conn.label = '房主';
      }
      localStorage.setItem('p1_contacts', JSON.stringify(state.contacts));
      if (window.ui) window.ui.renderList();
      return;
    }

    if (d.t === 'PEER_EX') {
      if (Array.isArray(d.list)) {
        d.list.forEach(id => {
          if (id && id !== state.myId && !state.conns[id]) {
            this.connectTo(id);
          }
        });
      }
      return;
    }

    if (d.t === 'MSG') {
      if (!d.id) return;
      if (state.seenMsgs.has(d.id)) return;
      state.seenMsgs.add(d.id);

      // 时间戳修正：保证收到的消息单调递增，避免乱序/沉底
      if (typeof d.ts === 'number') {
        d.ts = Math.max(d.ts, state.latestTs + 1);
      } else {
        d.ts = state.latestTs + 1;
      }
      state.latestTs = d.ts;

      if (d.n) {
        state.contacts[d.senderId] = {
          id: d.senderId, n: d.n, t: Date.now()
        };
        localStorage.setItem('p1_contacts', JSON.stringify(state.contacts));
      }

      const isPublic = d.target === 'all';
      const isToMe   = d.target === state.myId ||
                       (state.isHub && d.target === state.roomId);

      if (isPublic || isToMe) {
        const chatKey = isPublic ? 'all' : d.senderId;
        if (state.activeChat === chatKey) {
          if (window.ui) window.ui.appendMsg(d);
        } else {
          state.unread[chatKey] = (state.unread[chatKey] || 0) + 1;
          localStorage.setItem('p1_unread', JSON.stringify(state.unread));
          if (window.navigator && window.navigator.vibrate) {
            window.navigator.vibrate(200);
          }
          if (window.ui) window.ui.renderList();
        }
      }

      db.saveMsg(d);

      // 房主充当路由：转发私聊消息
      if (state.isHub && !isPublic && !isToMe) {
        const tId = d.target;
        const c   = state.conns[tId];
        if (c && c.open) {
          c.send(d);
        } else {
          db.addPending(d);
          this.connectTo(tId);
        }
      }

      if (d.target === 'all') {
        this.flood(d, conn.peer);
      }
    }
  },

  flood(pkt, excludePeerId) {
    if (typeof pkt.ttl === 'number') {
      if (pkt.ttl <= 0) return;
      pkt = Object.assign({}, pkt, { ttl: pkt.ttl - 1 });
    }
    Object.values(state.conns).forEach(c => {
      if (c.open && c.peer !== excludePeerId) {
        c.send(pkt);
      }
    });
  },

  async sendMsg(txt) {
    const now = Date.now();
    const pkt = {
      t: 'MSG',
      id: util.uuid(),
      n: state.myName,
      senderId: state.myId,
      target: state.activeChat,
      txt: txt,
      ts: now,
      ttl: CONST.TTL
    };
    state.seenMsgs.add(pkt.id);
    state.latestTs = Math.max(state.latestTs, pkt.ts);
    if (window.ui) window.ui.appendMsg(pkt);
    db.saveMsg(pkt);
    db.addPending(pkt);
    this.retryPending();
  },

  async retryPending() {
    const list = await db.getPending();
    if (!list || list.length === 0) return;

    const ready = Object.keys(state.conns)
      .some(k => state.conns[k] && state.conns[k].open);
    if (!ready) return;

    for (let i = 0; i < list.length; i++) {
      const pkt = list[i];
      if (!pkt) continue;

      if (pkt.target === 'all') {
        this.flood(pkt, null);
      } else {
        let sent = false;
        const direct = state.conns[pkt.target];
        if (direct && direct.open) {
          direct.send(pkt);
          sent = true;
        } else {
          const hub = state.conns[state.roomId];
          if (hub && hub.open) {
            hub.send(pkt);
            sent = true;
          }
        }
        if (!sent) {
          this.connectTo(pkt.target);
          continue;
        }
      }
      await db.removePending(pkt.id);
    }
  },

  sendPing() {
    Object.values(state.conns).forEach(c => {
      if (c.open) c.send({t: 'PING'});
    });
  },

  cleanup() {
    const now = Date.now();
    Object.keys(state.conns).forEach(pid => {
      const c = state.conns[pid];
      if (!c.open && now - (c.created || 0) > 10000) {
        delete state.conns[pid];
      }
    });
    if (window.ui) window.ui.renderList();
  },

  exchange() {
    const list    = Object.values(state.contacts).map(c => c.id).filter(Boolean);
    const onlines = Object.keys(state.conns);
    const full    = Array.from(new Set(list.concat(onlines)));
    const pkt     = {t: 'PEER_EX', list: full};
    Object.values(state.conns).forEach(c => {
      if (c.open) c.send(pkt);
    });
  },

  async loadHistory(limit) {
    if (state.loading) return;
    state.loading = true;
    const msgs = await db.getRecent(limit, state.activeChat, state.oldestTs);
    if (msgs && msgs.length > 0) {
      state.oldestTs = msgs[0].ts;
      msgs.forEach(m => {
        state.seenMsgs.add(m.id);
        if (window.ui) window.ui.appendMsg(m);
      });
    }
    state.loading = false;
  }
};

const ui = {
  init() {
    const bind = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.onclick = fn;
    };

    bind('btnSend', () => {
      const el = document.getElementById('editor');
      if (el && el.innerText.trim()) {
        core.sendMsg(el.innerText.trim());
        el.innerText = '';
      }
    });

    const editor = document.getElementById('editor');
    if (editor) {
      editor.addEventListener('paste', e => {
        e.preventDefault();
        const data = (e.clipboardData || window.clipboardData)
          .getData('text/plain');
        document.execCommand('insertText', false, data);
      });
    }

    bind('btnToggleLog', () => {
      const el = document.getElementById('miniLog');
      if (!el) return;
      el.style.display = (el.style.display === 'flex') ? 'none' : 'flex';
    });

    bind('btnSettings', () => {
      const panel = document.getElementById('settings-panel');
      if (panel) panel.style.display = 'grid';
      const iptNick = document.getElementById('iptNick');
      if (iptNick) iptNick.value = state.myName;
    });

    bind('btnCloseSettings', () => {
      const panel = document.getElementById('settings-panel');
      if (panel) panel.style.display = 'none';
    });

    bind('btnSave', () => {
      const iptNick = document.getElementById('iptNick');
      if (iptNick) {
        const n = iptNick.value.trim();
        if (n) {
          state.myName = n;
          localStorage.setItem('nickname', n);
          ui.updateSelf();
        }
      }
      const peerInput = document.getElementById('iptPeer');
      if (peerInput) {
        const pid = peerInput.value.trim();
        if (pid && pid !== state.myId) {
          state.contacts[pid] = { id: pid, n: pid, t: Date.now() };
          localStorage.setItem('p1_contacts', JSON.stringify(state.contacts));
          core.connectTo(pid);
          ui.renderList();
        }
        peerInput.value = '';
      }
      const panel = document.getElementById('settings-panel');
      if (panel) panel.style.display = 'none';
    });

    bind('btnFile', () => {
      const f = document.getElementById('fileInput');
      if (f) f.click();
    });

    const fileInput = document.getElementById('fileInput');
    if (fileInput) {
      fileInput.onchange = function(e) {
        const f = e.target.files[0];
        if (!f || f.size > 5*1024*1024) {
          alert('文件需<5MB');
          return;
        }
        const r = new FileReader();
        r.onload = ev => {
          core.sendMsg('[file=' + f.name + ']' +
                       ev.target.result + '[/file]');
        };
        r.readAsDataURL(f);
        this.value = '';
      };
    }

    bind('btnBack', () => {
      const bar = document.getElementById('sidebar');
      if (bar) bar.classList.remove('hidden');
    });

    bind('btnDlLog', () => {
      const el = document.getElementById('logContent');
      if (!el) return;
      const lines = Array.from(el.children)
        .map(n => n.innerText || '')
        .join('\n');
      const blob = new Blob([lines], {
        type: 'text/plain;charset=utf-8'
      });
      const url = URL.createObjectURL(blob);
      const a   = document.createElement('a');
      a.href      = url;
      a.download  = 'p1-log-' +
        new Date().toISOString().replace(/[:.]/g, '-') +
        '.txt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });

    const box = document.getElementById('msgList');
    if (box) {
      box.addEventListener('scroll', () => {
        if (box.scrollTop === 0) core.loadHistory(20);
      });
    }

    const contactListEl = document.getElementById('contactList');
    if (contactListEl) {
      contactListEl.addEventListener('click', e => {
        const item = e.target.closest('.contact-item');
        if (!item) return;
        const chatId   = item.getAttribute('data-chat-id');
        const chatName = item.getAttribute('data-chat-name') || '';
        if (chatId) ui.switchChat(chatId, chatName);
      });
    }

    this.updateSelf();
    this.renderList();
  },

  updateSelf() {
    const myIdEl = document.getElementById('myId');
    if (myIdEl) myIdEl.innerText = state.myId.slice(0,6);
    const nickEl = document.getElementById('myNick');
    if (nickEl) nickEl.innerText = state.myName;
    const statusText = document.getElementById('statusText');
    if (statusText) {
      statusText.innerText = state.isHub ? '👑 房主' : '在线';
    }
    const dot = document.getElementById('statusDot');
    if (dot) dot.className = 'dot online';
  },

  switchChat(name, displayName) {
    state.activeChat      = name;
    state.activeChatName  = displayName;
    state.unread[name]    = 0;
    localStorage.setItem('p1_unread', JSON.stringify(state.unread));

    // 重置为 Infinity，确保 getRecent 不过滤“未来时间”的消息
    state.oldestTs = Infinity;

    const titleEl  = document.getElementById('chatTitle');
    const statusEl = document.getElementById('chatStatus');
    if (titleEl)  titleEl.innerText  = displayName;
    if (statusEl) statusEl.innerText = (name === 'all') ? '全员' : '私聊';

    if (window.innerWidth < 768) {
      const bar = document.getElementById('sidebar');
      if (bar) bar.classList.add('hidden');
    }

    this.clearMsgs();
    core.loadHistory(50);
    this.renderList();
  },

  renderList() {
    const list = document.getElementById('contactList');
    if (!list) return;

    const onlineCount = Object.values(state.conns)
      .filter(c => c.open).length;
    const ocEl = document.getElementById('onlineCount');
    if (ocEl) ocEl.innerText = onlineCount;

    const pubUnread = state.unread['all'] || 0;
    // 去掉群聊头像，只保留文字
    let html = ''
      + '<div class="contact-item '
      + (state.activeChat === 'all' ? 'active' : '')
      + '" data-chat-id="all" data-chat-name="公共频道">'
      + '<div class="c-info"><div class="c-name">公共频道 '
      + (pubUnread > 0
         ? '<span class="unread-badge">' + pubUnread + '</span>'
         : '')
      + '</div></div></div>';

    const map = new Map();
    Object.keys(state.contacts).forEach(k => {
      const c = state.contacts[k];
      if (c && c.id) map.set(c.id, c);
    });
    Object.keys(state.conns).forEach(k => {
      const conn = state.conns[k];
      if (conn && conn.label) {
        map.set(k, { id: k, n: conn.label });
      }
    });

    map.forEach((v, id) => {
      if (!id || id === state.myId) return;
      const isOnline = state.conns[id] && state.conns[id].open;
      const isSeed   = id.indexOf('p1-room') !== -1;
      if (isSeed && !isOnline) return;

      const unread    = state.unread[id] || 0;
      const rawName   = v.n || '未知';
      const displayName = isSeed ? ' 房主' : rawName;
      const safeDisplayName = util.escape(displayName);
      const safeId         = util.escape(id);

      html += ''
        + '<div class="contact-item '
        + (state.activeChat === id ? 'active' : '')
        + '" data-chat-id="' + safeId + '"'
        + ' data-chat-name="' + safeDisplayName + '">'
        + '<div class="c-info">'
        + '<div class="c-name">' + safeDisplayName + ' '
        + (unread > 0
           ? '<span class="unread-badge">' + unread + '</span>'
           : '')
        + '</div>'
        + '<div class="c-time">' + (isOnline ? '在线' : '离线') + '</div>'
        + '</div></div>';
    });

    list.innerHTML = html;
  },

  clearMsgs() {
    const box = document.getElementById('msgList');
    if (box) box.innerHTML = '';
  },

  appendMsg(m) {
    const box = document.getElementById('msgList');
    if (!box || !m || !m.id) return;
    if (document.getElementById('msg-' + m.id)) return;

    let content = util.escape(m.txt);
    const isMe = m.senderId === state.myId;

    content = content.replace(/\[img\](.*?)\[\/img\]/g,
      '<img src="$1" class="chat-img" onclick="window.open(this.src)">');
    content = content.replace(
      /\[file=(.*?)\](.*?)\[\/file\]/g,
      '<a href="$2" download="$1" ' +
      'style="color:var(--text);text-decoration:underline">📄 $1</a>'
    );

    const timeStr = new Date(m.ts).toLocaleTimeString();
    const name    = isMe ? '我' : util.escape(m.n);

    // 去掉每条消息旁的小头像，只保留气泡和时间
    const html = ''
      + '<div class="msg-row ' + (isMe ? 'me' : 'other')
      + '" id="msg-' + m.id + '" data-ts="' + m.ts + '">'
      + '<div>'
      + '<div class="msg-bubble">' + content + '</div>'
      + '<div class="msg-meta">' + name + ' ' + timeStr + '</div>'
      + '</div></div>';

    const children = Array.from(box.children);
    let inserted   = false;
    for (let i = children.length - 1; i >= 0; i--) {
      const ts = parseInt(children[i].getAttribute('data-ts'), 10) || 0;
      if (m.ts >= ts) {
        if (i === children.length - 1) {
          box.insertAdjacentHTML('beforeend', html);
        } else {
          children[i + 1].insertAdjacentHTML('beforebegin', html);
        }
        inserted = true;
        break;
      }
    }

    if (!inserted) {
      if (children.length === 0) box.innerHTML = html;
      else box.insertAdjacentHTML('afterbegin', html);
    }

    const isAtBottom =
      box.scrollHeight - box.scrollTop - box.clientHeight < 100;
    if (isMe || isAtBottom) {
      box.scrollTop = box.scrollHeight;
    }
  }
};

window.core = core;
window.ui  = ui;
setTimeout(() => core.init(), 500);

})();