(function(){
'use strict';

// --- 1. 配置 ---
const CONFIG = {
  host: 'peerjs.92k.de', port: 443, secure: true, path: '/',
  config: { iceServers: [{urls:'stun:stun.l.google.com:19302'}] },
  debug: 1
};

const CONST = {
  MAX_PEERS: 8,
  MIN_PEERS: 4,
  PEX_INTERVAL: 10000,
  TTL: 16,
  SYNC_LIMIT: 100
};

// --- 2. 数据库 ---
const db = {
  _db: null,
  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('P1_DB', 1);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if(!d.objectStoreNames.contains('msgs')) d.createObjectStore('msgs', { keyPath: 'id' }).createIndex('ts', 'ts');
        if(!d.objectStoreNames.contains('pending')) d.createObjectStore('pending', { keyPath: 'id' });
      };
      req.onsuccess = (e) => { this._db = e.target.result; resolve(); };
      req.onerror = (e) => reject(e);
    });
  },
  async saveMsg(msg) {
    return new Promise(resolve => {
      const tx = this._db.transaction(['msgs'], 'readwrite');
      tx.objectStore('msgs').put(msg);
      tx.oncomplete = () => resolve();
    });
  },
  async getRecent(limit, target='all', beforeTs = Date.now()) {
    return new Promise(resolve => {
      const tx = this._db.transaction(['msgs'], 'readonly');
      const range = IDBKeyRange.upperBound(beforeTs, true);
      const req = tx.objectStore('msgs').index('ts').openCursor(range, 'prev');
      const res = [];
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && res.length < limit) {
          const m = cursor.value;
          const isPublic = target === 'all' && m.target === 'all';
          const isPrivate = target !== 'all' && ((m.target === target && m.senderId === state.myId) || (m.senderId === target && m.target === state.myId));
          if (isPublic || isPrivate) res.unshift(m);
          cursor.continue();
        } else resolve(res);
      };
    });
  },
  async addPending(msg) { this._db.transaction(['pending'], 'readwrite').objectStore('pending').put(msg); },
  async getPending() {
    return new Promise(r => {
      const req = this._db.transaction(['pending'], 'readonly').objectStore('pending').getAll();
      req.onsuccess = () => r(req.result);
    });
  },
  async removePending(id) { this._db.transaction(['pending'], 'readwrite').objectStore('pending').delete(id); }
};

// --- 3. 全局状态 ---
const state = {
  myId: localStorage.getItem('p1_my_id') || ('u_' + Math.random().toString(36).substr(2, 9)),
  myName: localStorage.getItem('nickname') || '用户'+Math.floor(Math.random()*1000),
  peer: null,
  conns: {}, 
  contacts: JSON.parse(localStorage.getItem('p1_contacts') || '{}'),
  isHub: false,
  roomId: '', 
  
  activeChat: 'all', activeChatName: '公共频道', 
  unread: JSON.parse(localStorage.getItem('p1_unread') || '{}'),
  seenMsgs: new Set(), latestTs: 0, oldestTs: Date.now(), loading: false
};

// --- 增强日志系统 ---
const logSystem = {
  logs: [],
  lastLog: null,
  count: 1,
  
  add(text) {
    const time = new Date().toLocaleTimeString();
    const msg = `[${time}] ${text}`;
    
    if (this.lastLog === text) {
      this.count++;
      // 更新最后一条 UI
      const el = document.getElementById('logContent');
      if(el && el.lastChild) {
        el.lastChild.innerText = `${msg} (x${this.count})`;
      }
    } else {
      this.count = 1;
      this.lastLog = text;
      this.logs.push(msg);
      if(this.logs.length > 500) this.logs.shift();
      
      const el = document.getElementById('logContent');
      if(el) {
        const div = document.createElement('div');
        div.innerText = msg;
        div.style.borderBottom = '1px solid #333';
        el.appendChild(div);
        el.scrollTop = el.scrollHeight;
      }
    }
    console.log(msg);
  }
};

const util = {
  log: (s) => logSystem.add(s),
  uuid: () => Math.random().toString(36).substr(2, 9) + Date.now().toString(36),
  escape: (s) => (s||'').toString().replace(/\x26/g, '\x26amp;').replace(/\x3c/g, '\x26lt;').replace(/\x3e/g, '\x26gt;').replace(/\x22/g, '\x26quot;').replace(/\x27/g, '\x26#039;')
};

// --- 4. 核心逻辑 ---
const core = {
  async init() {
    if(typeof Peer === 'undefined') return console.error('PeerJS missing');
    localStorage.setItem('p1_my_id', state.myId);
    await db.init();
    
    if(window.ui) window.ui.init();
    await this.loadHistory(20); // 启动加载
    
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
        if(c.lastTry && Date.now() - c.lastTry < 10000) return;
        if(c.id && c.id !== state.myId && (!state.conns[c.id] || !state.conns[c.id].open)) {
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
    if(state.peer && !state.peer.destroyed) return;
    util.log(`🚀 启动 (v9.4 增强版)`);
    
    try {
      const p = new Peer(state.myId, CONFIG);
      p.on('open', id => {
        state.myId = id;
        state.peer = p;
        util.log(`✅ 上线: ${id}`);
        if(window.ui) window.ui.updateSelf();
        setTimeout(() => this.connectTo(state.roomId), 500);
      });
      
      p.on('error', err => {
        util.log(`PeerErr: ${err.type}`);
        if (err.type === 'peer-unavailable' && err.message.includes('room')) {
           if(!state.isHub) {
             util.log('🚨 尝试上位...');
             state.isHub = true;
             state.peer.destroy();
             setTimeout(() => {
               const p2 = new Peer(state.roomId, CONFIG); 
               p2.on('open', () => {
                 state.peer = p2;
                 state.myId = state.roomId;
                 util.log('👑 成为房主');
                 if(window.ui) window.ui.updateSelf();
               });
               p2.on('error', e => {
                 if(e.type === 'unavailable-id') {
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
    } catch(e) { util.log(`Fatal: ${e}`); }
  },

  connectTo(id) {
    if(id === state.myId) return;
    if(!state.peer || state.peer.destroyed || (state.conns[id] && state.conns[id].open)) return;
    if(state.conns[id] && Date.now() - (state.conns[id].created||0) < 5000) return;

    try {
      const conn = state.peer.connect(id, {reliable: true});
      conn.created = Date.now();
      state.conns[id] = conn; 
      this.setupConn(conn);
    } catch(e){}
  },

  setupConn(conn) {
    conn.on('open', () => {
      state.conns[conn.peer] = conn;
      conn.send({t: 'HELLO', n: state.myName, id: state.myId});
      this.exchange(); 
      this.retryPending();
      if(window.ui) window.ui.renderList();
    });

    conn.on('data', d => this.handleData(d, conn));
    conn.on('close', () => { delete state.conns[conn.peer]; if(window.ui) window.ui.renderList(); });
    conn.on('error', () => { delete state.conns[conn.peer]; if(window.ui) window.ui.renderList(); });
  },

  async handleData(d, conn) {
    if(d.t === 'PING') return conn.send({t: 'PONG'});
    if(d.t === 'PONG') return; 

    if(d.t === 'HELLO') {
      conn.label = d.n;
      state.contacts[d.id] = {id: d.id, n: d.n, t: Date.now()};
      if(d.id === state.roomId) {
        state.contacts['房主'] = {id: state.roomId, t: Date.now(), n: '房主'};
        conn.label = '房主';
      }
      localStorage.setItem('p1_contacts', JSON.stringify(state.contacts));
      if(window.ui) window.ui.renderList();
    }
    
    if(d.t === 'PEER_EX') {
      d.list.forEach(id => {
        if(id !== state.myId && !state.conns[id]) this.connectTo(id);
      });
    }
    
    if(d.t === 'MSG') {
      if(state.seenMsgs.has(d.id)) return;
      state.seenMsgs.add(d.id);
      
      if(d.n) {
        state.contacts[d.senderId] = {id: d.senderId, n: d.n, t: Date.now()};
        localStorage.setItem('p1_contacts', JSON.stringify(state.contacts));
      }
      
      await db.saveMsg(d);
      
      const isPublic = d.target === 'all';
      const isToMe = d.target === state.myId || (state.isHub && d.target === state.roomId); 
      
      if (isPublic || isToMe) {
        const chatKey = isPublic ? 'all' : d.senderId;
        
        if (state.activeChat === chatKey) {
          if(window.ui) window.ui.appendMsg(d); // 如果正在看，直接上屏
        } else {
          state.unread[chatKey] = (state.unread[chatKey]||0) + 1;
          localStorage.setItem('p1_unread', JSON.stringify(state.unread));
          if(window.ui) window.ui.renderList(); // 如果没看，刷新列表显示红点
        }
      }
      
      if(d.target === 'all') this.flood(d, conn.peer);
    }
  },

  flood(pkt, exclude) {
    Object.values(state.conns).forEach(c => {
      if(c.peer !== exclude && c.open) c.send(pkt);
    });
  },

  async sendMsg(txt) {
    const pkt = {
      t: 'MSG', id: util.uuid(), n: state.myName, senderId: state.myId,
      target: state.activeChat, 
      txt: txt, ts: Date.now(), ttl: CONST.TTL
    };
    
    state.seenMsgs.add(pkt.id);
    state.latestTs = Math.max(state.latestTs, pkt.ts);
    
    await db.saveMsg(pkt);
    await db.addPending(pkt);
    if(window.ui) window.ui.appendMsg(pkt);
    
    this.retryPending();
  },
  
  async retryPending() {
    const list = await db.getPending();
    if(list.length === 0) return;
    const ready = Object.keys(state.conns).some(k => state.conns[k].open);
    if(!ready) return;

    list.forEach(async pkt => {
      if(pkt.target === 'all') {
        this.flood(pkt, null);
      } else {
        let sent = false;
        if (state.conns[pkt.target] && state.conns[pkt.target].open) {
          state.conns[pkt.target].send(pkt);
          sent = true;
        } else if (state.conns[state.roomId] && state.conns[state.roomId].open) {
          state.conns[state.roomId].send(pkt);
          sent = true;
        }
        if (!sent) { this.connectTo(pkt.target); return; }
      }
      await db.removePending(pkt.id); 
    });
  },

  sendPing() { Object.values(state.conns).forEach(c => { if(c.open) c.send({t: 'PING'}); }); },
  
  cleanup() { 
    const now = Date.now();
    Object.keys(state.conns).forEach(pid => { 
      const c = state.conns[pid];
      if(!c.open && (now - (c.created || 0) > 10000)) delete state.conns[pid]; 
    }); 
    if(window.ui) window.ui.renderList();
  },
  
  exchange() {
    const list = Object.values(state.contacts).map(c => c.id).filter(id => id);
    const onlines = Object.keys(state.conns);
    const fullList = [...new Set([...list, ...onlines])];
    const pkt = {t: 'PEER_EX', list: fullList};
    Object.values(state.conns).forEach(c => { if(c.open) c.send(pkt); });
  },

  async loadHistory(limit) {
    if(state.loading) return;
    state.loading = true;
    const msgs = await db.getRecent(limit, state.activeChat, state.oldestTs);
    if(msgs.length > 0) {
      state.oldestTs = msgs[0].ts;
      msgs.forEach(m => {
        state.seenMsgs.add(m.id);
        if(window.ui) window.ui.appendMsg(m);
      });
    }
    state.loading = false;
  }
};

// --- 5. UI (增强版) ---
const ui = {
  init() {
    const bind = (id, fn) => { const el = document.getElementById(id); if(el) el.onclick = fn; };
    bind('btnSend', () => {
      const el = document.getElementById('editor');
      if(el.innerText.trim()) { core.sendMsg(el.innerText.trim()); el.innerText=''; }
    });
    const editor = document.getElementById('editor');
    if(editor) editor.addEventListener('paste', e => {
        e.preventDefault();
        document.execCommand('insertText', false, (e.clipboardData||window.clipboardData).getData('text/plain'));
    });
    bind('btnToggleLog', () => { const el = document.getElementById('miniLog'); el.style.display = el.style.display === 'flex'?'none':'flex'; });
    bind('btnSettings', () => { document.getElementById('settings-panel').style.display = 'grid'; document.getElementById('iptNick').value = state.myName; });
    bind('btnCloseSettings', () => document.getElementById('settings-panel').style.display = 'none');
    bind('btnSave', () => {
       const n = document.getElementById('iptNick').value.trim();
       if(n) { state.myName = n; localStorage.setItem('nickname', n); ui.updateSelf(); }
       document.getElementById('settings-panel').style.display = 'none';
    });
    bind('btnFile', () => document.getElementById('fileInput').click());
    document.getElementById('fileInput').onchange = function(e) {
      const f = e.target.files[0];
      if(!f || f.size > 5*1024*1024) return alert('文件需<5MB');
      const r = new FileReader();
      r.onload = (ev) => core.sendMsg(`[file=${f.name}]${ev.target.result}[/file]`);
      r.readAsDataURL(f); this.value = '';
    };
    bind('btnBack', () => document.getElementById('sidebar').classList.remove('hidden'));
    const box = document.getElementById('msgList');
    box.addEventListener('scroll', () => { if(box.scrollTop === 0) core.loadHistory(20); });

    this.updateSelf();
    this.renderList();
  },

  updateSelf() {
    document.getElementById('myId').innerText = state.myId.slice(0,6);
    document.getElementById('myNick').innerText = state.myName;
    document.getElementById('statusText').innerText = state.isSeed ? '👑 房主' : '在线';
    document.getElementById('statusDot').className = 'dot online';
  },

  switchChat(name, id) {
    state.activeChat = name; // ID
    state.activeChatName = id; // Name
    state.unread[name] = 0;
    localStorage.setItem('p1_unread', JSON.stringify(state.unread));
    state.oldestTs = Date.now(); // 重置分页
    
    document.getElementById('chatTitle').innerText = id;
    document.getElementById('chatStatus').innerText = name === 'all' ? '全员' : '私聊';
    if(window.innerWidth < 768) document.getElementById('sidebar').classList.add('hidden');
    
    window.ui.clearMsgs();
    core.loadHistory(50); // 切换时立即加载历史
    this.renderList();
  },

  renderList() {
    const list = document.getElementById('contactList');
    const onlineCount = Object.values(state.conns).filter(c => c.open).length;
    document.getElementById('onlineCount').innerText = onlineCount;
    
    const pubUnread = state.unread['all'] || 0;
    let html = `
      <div class="contact-item ${state.activeChat==='all'?'active':''}" onclick="ui.switchChat('all', '公共频道')">
        <div class="avatar" style="background:#2a7cff">群</div>
        <div class="c-info"><div class="c-name">公共频道 ${pubUnread > 0 ? `<span class="unread-badge">${pubUnread}</span>` : ''}</div></div>
      </div>
    `;
    
    const map = new Map();
    Object.keys(state.contacts).forEach(k => map.set(state.contacts[k].id, state.contacts[k]));
    Object.keys(state.conns).forEach(k => { 
      let name = state.conns[k].label;
      if(!name && state.contacts[k]) name = state.contacts[k].n; 
      if(!map.has(k)) map.set(k, {id:k, n: name || '未知'}); 
    });
    
    map.forEach((v, id) => {
      if(id === state.myId) return; 
      const isOnline = state.conns[id] && state.conns[id].open;
      const isSeed = id.includes('p1-room');
      if (isSeed && !isOnline) return; 

      const unread = state.unread[id] || 0;
      let name = util.escape(v.n || '未知');
      if(isSeed) name = '👑 ' + '房主';
      
      html += `
        <div class="contact-item ${state.activeChat===id?'active':''}" onclick="ui.switchChat('${id}', '${name}')">
          <div class="avatar" style="background:${isOnline?'#22c55e':'#666'}">${name[0]}</div>
          <div class="c-info">
            <div class="c-name">${name} ${unread > 0 ? `<span class="unread-badge">${unread}</span>` : ''}</div>
            <div class="c-time">${isOnline?'在线':'离线'}</div>
          </div>
        </div>`;
    });
    list.innerHTML = html;
  },
  
  clearMsgs() { document.getElementById('msgList').innerHTML = ''; },

  appendMsg(m) {
    const box = document.getElementById('msgList');
    if(document.getElementById('msg-'+m.id)) return;
    
    let content = util.escape(m.txt);
    const isMe = m.senderId === state.myId;
    content = content.replace(/\[img\](.*?)\[\/img\]/g, '<img src="$1" class="chat-img" onclick="window.open(this.src)">');
    content = content.replace(/\[file=(.*?)\](.*?)\[\/file\]/g, '<a href="$2" download="$1" style="color:var(--text);text-decoration:underline">📄 $1</a>');
    
    const timeStr = new Date(m.ts).toLocaleTimeString();
    const name = isMe ? '我' : util.escape(m.n);
    
    const html = `
      <div class="msg-row ${isMe?'me':'other'}" id="msg-${m.id}" data-ts="${m.ts}">
        <div>
          <div class="msg-bubble">${content}</div>
          <div class="msg-meta">${name} ${timeStr}</div>
        </div>
      </div>`;

    const children = Array.from(box.children);
    let inserted = false;
    for (let i = children.length - 1; i >= 0; i--) {
      if (m.ts >= parseInt(children[i].getAttribute('data-ts'))) {
        if (i === children.length - 1) box.insertAdjacentHTML('beforeend', html);
        else children[i+1].insertAdjacentHTML('beforebegin', html);
        inserted = true; break;
      }
    }
    if (!inserted) {
      if (children.length === 0) box.innerHTML = html;
      else box.insertAdjacentHTML('afterbegin', html);
    }

    const isAtBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
    if (isMe || isAtBottom) box.scrollTop = box.scrollHeight;
  }
};

window.core = core;
window.ui = ui;
setTimeout(() => core.init(), 500);

})();