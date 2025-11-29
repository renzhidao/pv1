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
  async getRecent(limit, beforeTs = Date.now()) {
    return new Promise(resolve => {
      const tx = this._db.transaction(['msgs'], 'readonly');
      const range = IDBKeyRange.upperBound(beforeTs, true);
      const req = tx.objectStore('msgs').index('ts').openCursor(range, 'prev');
      const res = [];
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if(cursor && res.length < limit) { res.unshift(cursor.value); cursor.continue(); }
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
  async addPending(msg) {
    this._db.transaction(['pending'], 'readwrite').objectStore('pending').put(msg);
  },
  async getPending() {
    return new Promise(resolve => {
      const req = this._db.transaction(['pending'], 'readonly').objectStore('pending').getAll();
      req.onsuccess = () => resolve(req.result);
    });
  },
  async removePending(id) {
    this._db.transaction(['pending'], 'readwrite').objectStore('pending').delete(id);
  }
};

const state = {
  myId: null, isSeed: false, peer: null,
  activeConns: new Map(), knownPeers: new Set(), seenMsgs: new Set(),
  myName: localStorage.getItem('nickname') || '用户'+Math.floor(Math.random()*1000),
  latestTs: 0, oldestTs: Date.now(), loading: false
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
    
    await this.loadHistory(20);

    const seedId = `p1-seed-${Math.floor(Math.random() * CONST.SEED_COUNT)}`;
    util.log(`正在连接网络...`);
    
    try {
      await this.startPeer(seedId);
      state.isSeed = true;
      util.log(`我是基站节点: ${seedId}`);
    } catch (e) {
      await this.startPeer('u_' + util.uuid());
      this.connect(seedId);
    }

    setInterval(() => this.maintainMesh(), 3000);
    setInterval(() => this.gossipPex(), CONST.PEX_INTERVAL);
    setInterval(() => this.retryPending(), 5000);
    
    if(window.ui) window.ui.init();
  },

  async loadHistory(limit) {
    if(state.loading) return;
    state.loading = true;
    const msgs = await db.getRecent(limit, state.oldestTs);
    if(msgs.length > 0) {
      state.oldestTs = msgs[0].ts;
      state.latestTs = Math.max(state.latestTs, msgs[msgs.length-1].ts);
      msgs.forEach(m => {
        state.seenMsgs.add(m.id);
        if(window.ui) window.ui.appendMsg(m);
      });
    }
    state.loading = false;
  },

  startPeer(id) {
    return new Promise((resolve, reject) => {
      const p = new Peer(id, CONFIG);
      p.on('open', pid => { state.myId = pid; state.peer = p; if(window.ui) window.ui.updateSelf(); resolve(); });
      p.on('error', e => { if(e.type==='unavailable-id') reject(e); else util.log(`Error: ${e.type}`); });
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
      state.knownPeers.add(conn.peer);
      conn.send({ t: 'HELLO', n: state.myName });
      if(window.ui) window.ui.renderStat();
      this.sendSyncReq(conn.peer, state.latestTs);
      this.retryPending();
    });
    conn.on('data', d => this.handleData(d, conn));
    conn.on('close', () => this.cleanup(conn.peer));
    conn.on('error', () => this.cleanup(conn.peer));
  },

  cleanup(pid) {
    state.activeConns.delete(pid);
    if(window.ui) window.ui.renderStat();
  },

  async handleData(d, conn) {
    if(d.t === 'HELLO') state.knownPeers.add(conn.peer);
    if(d.t === 'PEX') d.peers.forEach(p => { if(p!==state.myId) state.knownPeers.add(p); });
    
    if(d.t === 'MSG') {
      if(state.seenMsgs.has(d.id)) return;
      state.seenMsgs.add(d.id);
      state.latestTs = Math.max(state.latestTs, d.ts);
      await db.saveMsg(d);
      if(window.ui) window.ui.appendMsg(d);
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
          if(window.ui) window.ui.appendMsg(m);
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
      t: 'MSG', id: util.uuid(), n: state.myName,
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
    if(state.activeConns.size < CONST.MIN_PEERS && state.knownPeers.size > 0) {
      const pool = Array.from(state.knownPeers).filter(id => !state.activeConns.has(id) && id !== state.myId);
      if(pool.length) this.connect(pool[Math.floor(Math.random()*pool.length)]);
      else this.connect(`p1-seed-${Math.floor(Math.random()*CONST.SEED_COUNT)}`);
    }
    if(state.activeConns.size > CONST.MAX_PEERS + 2 && !state.isSeed) {
      const peers = Array.from(state.activeConns.keys());
      const victim = peers[Math.floor(Math.random()*peers.length)];
      state.activeConns.get(victim).close();
      state.activeConns.delete(victim);
    }
  },

  gossipPex() {
    const sample = Array.from(state.knownPeers).sort(()=>Math.random()-0.5).slice(0, 20);
    this.broadcast({ t: 'PEX', peers: sample }, null);
  }
};

const ui = {
  init() {
    const bind = (id, fn) => { const el = document.getElementById(id); if(el) el.onclick = fn; };
    
    bind('btnSend', () => {
      const el = document.getElementById('editor');
      if(el.innerText.trim()) { core.sendMsg(el.innerText.trim()); el.innerText=''; }
    });
    
    const editor = document.getElementById('editor');
    if(editor) {
      editor.addEventListener('paste', e => {
        e.preventDefault();
        document.execCommand('insertText', false, (e.clipboardData||window.clipboardData).getData('text/plain'));
      });
    }
    
    // 恢复日志开关
    bind('btnToggleLog', () => { 
      const el = document.getElementById('miniLog'); 
      el.style.display = el.style.display === 'flex' ? 'none' : 'flex'; 
    });
    
    // 恢复设置功能
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

    // 恢复文件发送
    bind('btnFile', () => document.getElementById('fileInput').click());
    document.getElementById('fileInput').onchange = function(e) {
      const f = e.target.files[0];
      if(!f || f.size > 500*1024) return alert('文件需<500KB');
      const r = new FileReader();
      r.onload = (ev) => core.sendMsg(`[file=${f.name}]${ev.target.result}[/file]`);
      r.readAsDataURL(f);
      this.value = '';
    };

    // 滚动加载
    const box = document.getElementById('msgList');
    box.addEventListener('scroll', () => {
      if(box.scrollTop === 0) core.loadHistory(20);
    });
    
    // 汉化标题
    document.getElementById('chatTitle').innerText = '公共频道';
  },

  updateSelf() {
    document.getElementById('myId').innerText = state.myId.slice(0,6);
    document.getElementById('myNick').innerText = state.myName;
    document.getElementById('statusText').innerText = state.isSeed ? '基站' : '在线';
    document.getElementById('statusDot').className = 'dot online';
  },

  renderStat() {
    document.getElementById('onlineCount').innerText = `${state.activeConns.size}/${state.knownPeers.size}`;
    let html = `<div style="padding:10px;font-size:12px;color:#666">网络拓扑<br>直连: ${state.activeConns.size} | 已知: ${state.knownPeers.size}</div>`;
    state.activeConns.forEach((c, pid) => {
      html += `<div class="contact-item"><div class="avatar" style="background:#22c55e;width:24px;height:24px;font-size:10px">🔗</div><div class="c-info"><div class="c-name" style="font-size:12px">${pid.slice(0,8)}</div></div></div>`;
    });
    document.getElementById('contactList').innerHTML = html;
  },

  appendMsg(m) {
    const box = document.getElementById('msgList');
    if(document.getElementById('msg-'+m.id)) return;
    
    let content = util.escape(m.txt);
    const isMe = m.n === state.myName;
    content = content.replace(/\[img\](.*?)\[\/img\]/g, '<img src="$1" class="chat-img" onclick="window.open(this.src)">');
    content = content.replace(/\[file=(.*?)\](.*?)\[\/file\]/g, '<a href="$2" download="$1" style="color:var(--text);text-decoration:underline">📄 $1</a>');
    
    const timeStr = new Date(m.ts).toLocaleTimeString();
    
    const html = `
      <div class="msg-row ${isMe?'me':'other'}" id="msg-${m.id}" data-ts="${m.ts}">
        <div>
          <div class="msg-bubble">${content}</div>
          <div class="msg-meta">${util.escape(m.n)} ${timeStr}</div>
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