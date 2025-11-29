(function(){
'use strict';

const CONFIG = {
  host: 'peerjs.92k.de', port: 443, secure: true, path: '/',
  config: { iceServers: [{urls:'stun:stun.l.google.com:19302'}] },
  debug: 1
};

const CONST = {
  SEED_COUNT: 20,
  MAX_PEERS: 8,
  MIN_PEERS: 4,
  PEX_INTERVAL: 10000,
  TTL: 16,
  SYNC_LIMIT: 100
};

// --- 数据库 (不变) ---
const db = {
  _db: null,
  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('P1_DB', 1);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if(!d.objectStoreNames.contains('msgs')) d.createObjectStore('msgs', { keyPath: 'id' }).createIndex('ts', 'ts', { unique: false });
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
  async getRecent(limit, target='all', beforeTs = Date.now()) { // 增加 target 过滤
    return new Promise(resolve => {
      const tx = this._db.transaction(['msgs'], 'readonly');
      const range = IDBKeyRange.upperBound(beforeTs, true);
      const req = tx.objectStore('msgs').index('ts').openCursor(range, 'prev');
      const res = [];
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if(cursor && res.length < limit) {
          // 过滤逻辑：只取属于当前会话的消息
          const m = cursor.value;
          if (m.target === target || (m.senderId === state.myId && m.target === target) || (target !== 'all' && m.senderId === target && m.target === state.myId)) {
             res.unshift(m);
          }
          cursor.continue();
        }
        else resolve(res);
      };
    });
  },
  async getAfter(limit, afterTs) {
    return new Promise(resolve => {
      const tx = this._db.transaction(['msgs'], 'readonly');
      const range = IDBKeyRange.lowerBound(afterTs, true);
      const req = tx.objectStore('msgs').index('ts').openCursor(range, 'next');
      const res = [];
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if(cursor && res.length < limit) { res.push(cursor.value); cursor.continue(); }
        else resolve(res);
      };
    });
  },
  async addPending(msg) { this._db.transaction(['pending'], 'readwrite').objectStore('pending').put(msg); },
  async getPending() {
    return new Promise(resolve => {
      const req = this._db.transaction(['pending'], 'readonly').objectStore('pending').getAll();
      req.onsuccess = () => resolve(req.result);
    });
  },
  async removePending(id) { this._db.transaction(['pending'], 'readwrite').objectStore('pending').delete(id); }
};

const state = {
  myId: null, isSeed: false, peer: null,
  activeConns: new Map(), knownPeers: new Map(), // Map<ID, {n:name, ts:time}>
  seenMsgs: new Set(),
  myName: localStorage.getItem('nickname') || '用户'+Math.floor(Math.random()*1000),
  latestTs: 0,
  
  // UI 状态恢复
  activeChat: 'all', // 'all' or PeerID
  activeChatName: '公共频道',
  unread: {} 
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

const core = {
  async init() {
    if(typeof Peer === 'undefined') return console.error('PeerJS missing');
    await db.init();
    
    // 先加载公共频道历史
    await this.refreshHistory();

    const seedId = `p1-seed-${Math.floor(Math.random() * CONST.SEED_COUNT)}`;
    util.log(`启动中...`);
    
    try {
      await this.startPeer(seedId);
      state.isSeed = true;
      util.log(`我是基站: ${seedId}`);
      // 修复：即使我是基站，也要去连其他基站，防止孤岛
      this.connectToSeeds();
    } catch (e) {
      await this.startPeer('u_' + util.uuid());
      this.connect(seedId); // 连抢占位的那个
      this.connectToSeeds(); // 多连几个
    }

    setInterval(() => this.maintainMesh(), 3000);
    setInterval(() => this.gossipPex(), CONST.PEX_INTERVAL);
    setInterval(() => this.retryPending(), 5000);
    
    if(window.ui) window.ui.init();
  },
  
  connectToSeeds() {
    // 随机连 3 个其他种子，确保大网互通
    for(let i=0; i<3; i++) {
      const s = `p1-seed-${Math.floor(Math.random() * CONST.SEED_COUNT)}`;
      if(s !== state.myId) this.connect(s);
    }
  },

  async refreshHistory() {
    const msgs = await db.getRecent(50, state.activeChat); // 根据当前聊天对象加载
    if(window.ui) window.ui.clearMsgs();
    msgs.forEach(m => {
      state.seenMsgs.add(m.id);
      state.latestTs = Math.max(state.latestTs, m.ts);
      if(window.ui) window.ui.appendMsg(m);
    });
  },

  startPeer(id) {
    return new Promise((resolve, reject) => {
      const p = new Peer(id, CONFIG);
      p.on('open', pid => { state.myId = pid; state.peer = p; if(window.ui) window.ui.updateSelf(); resolve(); });
      p.on('error', e => { if(e.type==='unavailable-id') reject(e); });
      p.on('connection', c => this.handleConn(c));
    });
  },

  connect(id) {
    if(id === state.myId || state.activeConns.has(id) || state.activeConns.size >= CONST.MAX_PEERS) return;
    try { this.handleConn(state.peer.connect(id, {reliable:true})); } catch(e){}
  },

  handleConn(conn) {
    conn.on('open', () => {
      state.activeConns.set(conn.peer, conn);
      state.knownPeers.set(conn.peer, {n: conn.label || '未知', ts: Date.now()});
      conn.send({ t: 'HELLO', n: state.myName });
      if(window.ui) window.ui.renderList();
      this.sendSyncReq(conn.peer, state.latestTs);
      this.retryPending();
    });
    conn.on('data', d => this.handleData(d, conn));
    conn.on('close', () => this.cleanup(conn.peer));
    conn.on('error', () => this.cleanup(conn.peer));
  },

  cleanup(pid) {
    state.activeConns.delete(pid);
    if(window.ui) window.ui.renderList();
  },

  async handleData(d, conn) {
    if(d.t === 'HELLO') {
      state.knownPeers.set(conn.peer, {n: d.n, ts: Date.now()});
      if(window.ui) window.ui.renderList();
    }
    if(d.t === 'PEX') {
      d.peers.forEach(p => { 
        if(p.id!==state.myId && !state.knownPeers.has(p.id)) state.knownPeers.set(p.id, {n: p.n, ts: Date.now()}); 
      });
      if(window.ui) window.ui.renderList();
    }
    
    if(d.t === 'MSG') {
      if(state.seenMsgs.has(d.id)) return;
      state.seenMsgs.add(d.id);
      state.latestTs = Math.max(state.latestTs, d.ts);
      
      // 更新发信人信息
      state.knownPeers.set(d.senderId, {n: d.n, ts: Date.now()});
      
      await db.saveMsg(d);
      
      // 只有当消息是发给“全员”或者“我”时，才处理 UI
      const isPublic = d.target === 'all';
      const isToMe = d.target === state.myId;
      
      if (isPublic || isToMe) {
        // 如果当前正好在看这个频道，上屏；否则加红点
        const chatKey = isPublic ? 'all' : d.senderId;
        if (state.activeChat === chatKey) {
          if(window.ui) window.ui.appendMsg(d);
        } else {
          state.unread[chatKey] = (state.unread[chatKey]||0) + 1;
          if(window.ui) window.ui.renderList();
        }
      }
      
      // 转发 (Gossip): 无论是不是发给我的，只要 TTL > 0 都要转发（这就是“网络层”）
      if(d.ttl > 0) { d.ttl--; this.broadcast(d, conn.peer); }
    }

    if(d.t === 'SYNC_REQ') {
      const msgs = await db.getAfter(CONST.SYNC_LIMIT, d.afterTs);
      if(msgs.length > 0) conn.send({ t: 'SYNC_RES', msgs: msgs });
    }
    
    if(d.t === 'SYNC_RES') {
      d.msgs.forEach(async m => {
        if(!state.seenMsgs.has(m.id)) {
          state.seenMsgs.add(m.id);
          state.latestTs = Math.max(state.latestTs, m.ts);
          await db.saveMsg(m);
          // 同步回来的消息也要判断归属
          const chatKey = m.target === 'all' ? 'all' : (m.target === state.myId ? m.senderId : null);
          if (chatKey && state.activeChat === chatKey && window.ui) window.ui.appendMsg(m);
        }
      });
    }
  },

  broadcast(pkt, excludeId) {
    for(const [pid, conn] of state.activeConns) {
      if(pid !== excludeId && conn.open) conn.send(pkt);
    }
  },

  async sendMsg(txt) {
    const pkt = {
      t: 'MSG', id: util.uuid(), n: state.myName, senderId: state.myId,
      target: state.activeChat, // 'all' or PeerID
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
    if(state.activeConns.size === 0) return;
    const list = await db.getPending();
    list.forEach(async pkt => {
      this.broadcast(pkt, null);
      await db.removePending(pkt.id); 
    });
  },

  sendSyncReq(targetPeer, afterTs) {
    const conn = state.activeConns.get(targetPeer);
    if(conn && conn.open) conn.send({ t: 'SYNC_REQ', afterTs: afterTs });
  },

  maintainMesh() {
    for(const [pid, conn] of state.activeConns) if(!conn.open) state.activeConns.delete(pid);
    
    // 补人
    if(state.activeConns.size < CONST.MIN_PEERS && state.knownPeers.size > 0) {
      const pool = Array.from(state.knownPeers.keys()).filter(id => !state.activeConns.has(id) && id !== state.myId);
      if(pool.length) this.connect(pool[Math.floor(Math.random()*pool.length)]);
      else this.connectToSeeds();
    }
    // 裁人
    if(state.activeConns.size > CONST.MAX_PEERS + 2 && !state.isSeed) {
      const peers = Array.from(state.activeConns.keys());
      const victim = peers[Math.floor(Math.random()*peers.length)];
      state.activeConns.get(victim).close();
      state.activeConns.delete(victim);
    }
  },

  gossipPex() {
    const list = [];
    state.knownPeers.forEach((v, k) => list.push({id: k, n: v.n}));
    const sample = list.sort(()=>Math.random()-0.5).slice(0, 20);
    this.broadcast({ t: 'PEX', peers: sample }, null);
  }
};

// --- UI 逻辑 (完全回滚到原版风格) ---
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
    
    bind('btnToggleLog', () => { 
      const el = document.getElementById('miniLog'); 
      el.style.display = el.style.display === 'flex' ? 'none' : 'flex'; 
    });
    
    bind('btnSettings', () => {
       document.getElementById('settings-panel').style.display = 'grid';
       document.getElementById('iptNick').value = state.myName;
    });
    bind('btnCloseSettings', () => document.getElementById('settings-panel').style.display = 'none');
    bind('btnSave', () => {
       const n = document.getElementById('iptNick').value.trim();
       if(n) { state.myName = n; localStorage.setItem('nickname', n); ui.updateSelf(); }
       document.getElementById('settings-panel').style.display = 'none';
    });

    bind('btnFile', () => document.getElementById('fileInput').click());
    document.getElementById('fileInput').onchange = function(e) {
      const f = e.target.files[0];
      if(!f || f.size > 500*1024) return alert('文件需<500KB');
      const r = new FileReader();
      r.onload = (ev) => core.sendMsg(`[file=${f.name}]${ev.target.result}[/file]`);
      r.readAsDataURL(f);
      this.value = '';
    };
    
    // 手机端侧边栏开关
    bind('btnBack', () => document.getElementById('sidebar').classList.remove('hidden'));

    this.updateSelf();
    this.renderList();
  },

  updateSelf() {
    document.getElementById('myId').innerText = state.myId.slice(0,6);
    document.getElementById('myNick').innerText = state.myName;
    document.getElementById('statusText').innerText = state.isSeed ? '基站' : '在线';
    document.getElementById('statusDot').className = 'dot online';
  },
  
  // 核心：恢复 switchChat 逻辑
  switchChat(target, name) {
    state.activeChat = target;
    state.activeChatName = name;
    state.unread[target] = 0;
    
    document.getElementById('chatTitle').innerText = name;
    document.getElementById('chatStatus').innerText = target === 'all' ? '全员' : '私聊';
    
    // 移动端收起侧边栏
    if(window.innerWidth < 768) document.getElementById('sidebar').classList.add('hidden');
    
    // 重新加载该会话的历史记录
    core.refreshHistory();
    this.renderList();
  },

  // 核心：恢复原版列表渲染
  renderList() {
    const list = document.getElementById('contactList');
    document.getElementById('onlineCount').innerText = state.activeConns.size; // 显示直连数
    
    // 公共频道项
    const pubUnread = state.unread['all'] || 0;
    let html = `
      <div class="contact-item ${state.activeChat==='all'?'active':''}" onclick="ui.switchChat('all', '公共频道')">
        <div class="avatar" style="background:#2a7cff">群</div>
        <div class="c-info">
          <div class="c-name">
            公共频道
            ${pubUnread > 0 ? `<span class="unread-badge">${pubUnread}</span>` : ''}
          </div>
        </div>
      </div>
    `;
    
    // 用户列表项 (从 knownPeers 渲染)
    state.knownPeers.forEach((v, id) => {
      if (id === state.myId) return;
      const unread = state.unread[id] || 0;
      const isOnline = state.activeConns.has(id); // 直连的才算“在线”显示绿色，否则灰色
      
      html += `
        <div class="contact-item ${state.activeChat===id?'active':''}" onclick="ui.switchChat('${id}', '${util.escape(v.n)}')">
          <div class="avatar" style="background:${isOnline?'#22c55e':'#666'}">${v.n[0]}</div>
          <div class="c-info">
            <div class="c-name">
              ${util.escape(v.n)} 
              ${unread > 0 ? `<span class="unread-badge">${unread}</span>` : ''}
            </div>
            <div class="c-time">${isOnline?'直连':'离线'}</div>
          </div>
        </div>`;
    });
    
    list.innerHTML = html;
  },
  
  clearMsgs() {
    document.getElementById('msgList').innerHTML = '';
  },

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
      const el = children[i];
      const ts = parseInt(el.getAttribute('data-ts') || '0');
      if (m.ts >= ts) {
        if (i === children.length - 1) box.insertAdjacentHTML('beforeend', html);
        else children[i+1].insertAdjacentHTML('beforebegin', html);
        inserted = true;
        break;
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