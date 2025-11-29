(function(){
'use strict';

// --- 1. 配置 (回归 v2 经典配置) ---
const CONFIG = {
  host: 'peerjs.92k.de', port: 443, secure: true, path: '/',
  config: { iceServers: [{urls:'stun:stun.l.google.com:19302'}] },
  debug: 1
};

// 房间号生成 (每1小时轮换，比v2的10分钟更稳)
const getRoomId = () => 'p1-room-' + Math.floor(Date.now() / 3600000);

// --- 2. 数据库 (保留新版功能) ---
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
        if(cursor && res.length < limit) {
          const m = cursor.value;
          if (m.target === target || (m.senderId === state.myId && m.target === target) || (target !== 'all' && m.senderId === target && m.target === state.myId)) {
             res.unshift(m);
          }
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
  myName: localStorage.getItem('nickname') || 'User-'+Math.floor(Math.random()*1000),
  peer: null,
  conns: {}, // v2 风格连接池
  contacts: JSON.parse(localStorage.getItem('p1_contacts') || '{}'),
  
  // 新版状态
  activeChat: 'all', 
  activeChatName: '公共频道',
  unread: {},
  seenMsgs: new Set(),
  latestTs: 0,
  oldestTs: Date.now(),
  loading: false
};

const util = {
  log(s) {
    const el = document.getElementById('logContent');
    if(el) el.innerText = `[${new Date().toLocaleTimeString()}] ${s}\n` + el.innerText.slice(0, 2000);
    console.log(`[P1] ${s}`);
  },
  uuid() { return Math.random().toString(36).substr(2, 9) + Date.now().toString(36); },
  escape(s) {
    return (s||'').toString().replace(/\x26/g, '\x26amp;').replace(/\x3c/g, '\x26lt;').replace(/\x3e/g, '\x26gt;').replace(/\x22/g, '\x26quot;').replace(/\x27/g, '\x26#039;');
  }
};

// --- 4. 核心逻辑 (v2 连接架构 + v3 数据处理) ---
const core = {
  async init() {
    if(typeof Peer === 'undefined') return console.error('PeerJS missing');
    localStorage.setItem('p1_my_id', state.myId);
    
    await db.init();
    await this.loadHistory(20);
    
    this.startPeer();
    
    // v2 核心循环：定期清理、重连房间、重连联系人
    setInterval(() => {
      this.cleanup();
      const roomId = getRoomId();
      
      // 房间连接逻辑 (v2)
      const hubConn = state.conns[roomId];
      if (!hubConn || !hubConn.open) this.connectTo(roomId);
      
      // 联系人重连 (v2)
      Object.values(state.contacts).forEach(c => {
        if(c.id && c.id !== state.myId && (!state.conns[c.id] || !state.conns[c.id].open)) {
           this.connectTo(c.id);
        }
      });
      
      this.sendPing();
      this.retryPending(); // 新版：离线重发
    }, 5000);
    
    if(window.ui) window.ui.init();
  },

  startPeer() {
    if(state.peer && !state.peer.destroyed) return;
    util.log(`🚀 启动 (v2.5 融合版)`);
    
    try {
      const p = new Peer(state.myId, CONFIG);
      p.on('open', id => {
        state.myId = id;
        state.peer = p;
        util.log(`✅ 上线: ${id}`);
        if(window.ui) window.ui.updateSelf();
        this.connectTo(getRoomId()); // 立即进房
      });
      
      p.on('error', err => {
        util.log(`PeerErr: ${err.type}`);
        // v2 经典容错：如果房间满员/不可用，尝试接管（简单版）
        if (err.type === 'peer-unavailable' && err.message.includes('room')) {
           // 这里不做复杂抢主，直接等待或重试，保持 v2 的简单性
        }
      });
      
      p.on('connection', conn => this.setupConn(conn));
    } catch(e) { util.log(`Fatal: ${e}`); }
  },

  connectTo(id) {
    if(!state.peer || state.peer.destroyed || id === state.myId || (state.conns[id] && state.conns[id].open)) return;
    try {
      const conn = state.peer.connect(id, {reliable: true});
      this.setupConn(conn);
    } catch(e){}
  },

  setupConn(conn) {
    conn.on('open', () => {
      state.conns[conn.peer] = conn;
      if(window.ui) window.ui.renderList();
      conn.send({t: 'HELLO', n: state.myName, id: state.myId});
      this.exchange(); // v2 交换逻辑
      this.retryPending(); // 连上人就尝试发离线消息
    });

    conn.on('data', d => this.handleData(d, conn));
    conn.on('close', () => { delete state.conns[conn.peer]; if(window.ui) window.ui.renderList(); });
    conn.on('error', () => { delete state.conns[conn.peer]; if(window.ui) window.ui.renderList(); });
  },

  async handleData(d, conn) {
    if(d.t === 'PING') return conn.send({t: 'PONG'});
    if(d.t === 'PONG') return; // 简化处理

    if(d.t === 'HELLO') {
      conn.label = d.n;
      state.contacts[d.n] = {id: d.id || conn.peer, t: Date.now()};
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
      state.latestTs = Math.max(state.latestTs, d.ts);
      
      // v3 增强：存库 + UI逻辑
      await db.saveMsg(d);
      
      const isPublic = d.target === 'all';
      const isToMe = d.target === state.myId;
      
      if (isPublic || isToMe) {
        const chatKey = isPublic ? 'all' : d.senderId;
        if (state.activeChat === chatKey) {
          if(window.ui) window.ui.appendMsg(d);
        } else {
          state.unread[chatKey] = (state.unread[chatKey]||0) + 1;
          if(window.ui) window.ui.renderList();
        }
      }
      
      // v2 转发逻辑：如果是群聊，扩散给除来源外的所有人
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
      target: state.activeChat, // 'all' or PeerID
      txt: txt, ts: Date.now()
    };
    
    state.seenMsgs.add(pkt.id);
    state.latestTs = Math.max(state.latestTs, pkt.ts);
    
    // 先存库，再进队列，再展示
    await db.saveMsg(pkt);
    await db.addPending(pkt);
    if(window.ui) window.ui.appendMsg(pkt);
    
    this.retryPending();
  },
  
  async retryPending() {
    const list = await db.getPending();
    if(list.length === 0) return;
    
    // 只要连上任何一个人（且不是房间ID本身），就开始尝试发送
    const ready = Object.keys(state.conns).some(id => !id.includes('p1-room'));
    if(!ready) return;

    list.forEach(async pkt => {
      if(pkt.target === 'all') {
        this.flood(pkt, null);
      } else {
        // 私聊：尝试直连发送
        const conn = state.conns[pkt.target];
        if(conn && conn.open) conn.send(pkt);
        else {
          // 如果没连上目标，先尝试连一下，暂不删队列
          this.connectTo(pkt.target); 
          return; 
        }
      }
      // 发送成功（或已广播），移出队列
      await db.removePending(pkt.id); 
    });
  },

  sendPing() {
    Object.values(state.conns).forEach(c => { if(c.open) c.send({t: 'PING'}); });
  },

  cleanup() {
    Object.keys(state.conns).forEach(pid => { if(!state.conns[pid].open) delete state.conns[pid]; });
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

// --- 5. UI (保持最新版汉化界面) ---
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
    document.getElementById('statusText').innerText = '在线';
    document.getElementById('statusDot').className = 'dot online';
  },

  switchChat(target, name) {
    state.activeChat = target;
    state.activeChatName = name;
    state.unread[target] = 0;
    state.oldestTs = Date.now(); // 重置分页游标
    
    document.getElementById('chatTitle').innerText = name;
    document.getElementById('chatStatus').innerText = target === 'all' ? '全员' : '私聊';
    if(window.innerWidth < 768) document.getElementById('sidebar').classList.add('hidden');
    
    window.ui.clearMsgs();
    core.loadHistory(50); // 重新加载该会话历史
    this.renderList();
  },

  renderList() {
    const list = document.getElementById('contactList');
    document.getElementById('onlineCount').innerText = Object.keys(state.conns).length;
    
    const pubUnread = state.unread['all'] || 0;
    let html = `
      <div class="contact-item ${state.activeChat==='all'?'active':''}" onclick="ui.switchChat('all', '公共频道')">
        <div class="avatar" style="background:#2a7cff">群</div>
        <div class="c-info"><div class="c-name">公共频道 ${pubUnread > 0 ? `<span class="unread-badge">${pubUnread}</span>` : ''}</div></div>
      </div>
    `;
    
    // 合并 contacts 和 activeConns
    const map = new Map();
    Object.keys(state.contacts).forEach(k => map.set(state.contacts[k].id, state.contacts[k]));
    Object.keys(state.conns).forEach(k => { if(!map.has(k)) map.set(k, {id:k, n:state.conns[k].label}); });
    
    map.forEach((v, id) => {
      if(id === state.myId || id.includes('p1-room')) return;
      const unread = state.unread[id] || 0;
      const isOnline = !!state.conns[id];
      const name = util.escape(v.n || '未知');
      
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

    // 排序插入
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