(function(){
'use strict';

// ===================== 配置 =====================
const CONFIG = {
  host: 'peerjs.92k.de', port: 443, secure: true, path: '/',
  config: { 
    iceServers: [
      {urls:'stun:stun.l.google.com:19302'},
      {urls:'stun:stun1.l.google.com:19302'}
    ] 
  },
  debug: 0
};
const MAX_NEIGHBORS = 50; 
const SEEDS = ['p1-s1', 'p1-s2', 'p1-s3']; 
const CHUNK_SIZE = 64 * 1024;
const PING_INTERVAL = 5000; // 5秒心跳

// ===================== 核心 =====================
const app = {
  myId: '',
  myName: localStorage.getItem('nickname') || 'User-'+Math.floor(Math.random()*10000),
  peer: null,
  conns: {}, 
  knownPeers: new Set(), 
  seenMsgs: new Set(),
  fileChunks: {},
  isSeed: false,
  lastActivity: Date.now(), // 最后活跃时间

  log(s) {
    const el = document.getElementById('miniLog');
    if(el) el.innerText = `[${new Date().toLocaleTimeString()}] ${s}\n` + el.innerText.slice(0, 300);
  },

  init() {
    this.start();
    
    // 定时维护
    setInterval(() => {
      this.cleanup();
      this.exchangePeers();
      this.checkNetworkHealth();
      this.sendHeartbeat(); // 发送心跳
    }, PING_INTERVAL);
    
    setInterval(() => this.seenMsgs.clear(), 60000);

    // 监听页面可见性（后台回来强制检查）
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.log('👀 页面唤醒，检查连接...');
        this.checkNetworkHealth(true); // 强制检查
        // 如果 Peer 断了，重连 Peer
        if (!this.peer || this.peer.disconnected) {
          this.log('🔄 Peer断开，重连中...');
          this.peer.reconnect();
        }
      }
    });
  },

  start() {
    if(this.peer) return;
    const savedId = localStorage.getItem('myPeerId');
    this.initPeer(savedId, false);
  },

  initPeer(id, trySeed = false) {
    try {
      if(this.peer) this.peer.destroy(); // 确保旧的销毁
      
      const p = new Peer(id, CONFIG);
      p.on('open', myId => {
        this.myId = myId;
        this.peer = p;
        this.isSeed = SEEDS.includes(myId);
        localStorage.setItem('myPeerId', myId);
        this.log(`✅ 就绪: ${myId.slice(0,6)}`);
        ui.updateSelf();
        SEEDS.forEach(s => { if(s !== myId) this.connectTo(s); });
      });
      
      p.on('error', err => {
        this.log('Peer ERR: ' + err.type);
        if(err.type === 'unavailable-id') this.initPeer(undefined, false);
        if(err.type === 'disconnected' || err.type === 'network') {
            setTimeout(() => this.peer.reconnect(), 2000);
        }
      });
      
      p.on('disconnected', () => {
          this.log('🔌 Peer掉线，尝试重连...');
          setTimeout(() => { if(this.peer) this.peer.reconnect(); }, 1000);
      });

      p.on('connection', conn => this.handleConn(conn, true));
    } catch(e) { this.log('ERR: '+e); }
  },

  connectTo(targetId) {
    if(targetId === this.myId || this.conns[targetId]) return;
    if(Object.keys(this.conns).length >= MAX_NEIGHBORS) return;
    const conn = this.peer.connect(targetId, {reliable: true});
    this.handleConn(conn, false);
  },

  handleConn(conn, isIncoming) {
    const pid = conn.peer;
    
    // 绑定事件前先解绑旧的（防止重复）
    conn.removeAllListeners && conn.removeAllListeners();

    conn.on('open', () => {
      this.conns[pid] = conn;
      conn.lastPing = Date.now(); // 初始化心跳时间
      this.knownPeers.add(pid);
      ui.renderList();
      
      // 握手
      conn.send({t: 'HELLO', n: this.myName});
      const list = [...this.knownPeers, ...Object.keys(this.conns)];
      conn.send({t: 'PEER_EX', list: list});
      
      if(ui.activeChat === pid) ui.switchChat(pid);
    });

    conn.on('data', d => {
      conn.lastPing = Date.now(); // 收到任何数据都算活的
      
      if(d.t === 'PING') {
          conn.send({t: 'PONG'}); // 回应心跳
          return;
      }
      if(d.t === 'PONG') return;

      if(d.t === 'HELLO') { conn.label = d.n; ui.renderList(); }
      
      if(d.t === 'PEER_EX' && Array.isArray(d.list)) {
        d.list.forEach(id => {
          this.knownPeers.add(id);
          if (Object.keys(this.conns).length < 10 && id !== this.myId) this.connectTo(id);
        });
        ui.renderList();
      }
      
      if(d.t === 'MSG') {
        if(this.seenMsgs.has(d.id)) return; 
        this.seenMsgs.add(d.id);
        if(d.target === 'all' || d.target === this.myId) {
          const isPrivate = d.target !== 'all';
          if( (ui.activeChat === 'all' && !isPrivate) || (ui.activeChat === d.from && isPrivate) ) {
             ui.appendMsg(d.sender, d.txt, false, false, d.isHtml);
          } else if (isPrivate) {
             this.log(`🔔 收到 ${d.sender} 的私信`);
          }
        }
        if(d.target === 'all') this.flood(d, pid); 
      }
      
      if(d.t === 'FILE_START') {
        this.fileChunks[d.fid] = { meta: d.meta, buffer: [], received: 0 };
        if(ui.activeChat === pid) ui.appendMsg('系统', `正在接收 ${d.meta.name}...`, false, true);
      }
      if(d.t === 'FILE_CHUNK') {
        const f = this.fileChunks[d.fid];
        if(f) {
          f.buffer.push(d.data);
          f.received += d.data.byteLength;
          if(f.received >= f.meta.size) {
            const blob = new Blob(f.buffer, {type: f.meta.type});
            const url = URL.createObjectURL(blob);
            if(ui.activeChat === pid) ui.appendMsg(conn.label, `<a href="${url}" download="${f.meta.name}" style="color:#4ade80">📄 ${f.meta.name}</a>`, false, false, true);
            delete this.fileChunks[d.fid];
          }
        }
      }
    });

    const closeConn = () => this.dropPeer(pid);
    conn.on('close', closeConn);
    conn.on('error', closeConn);
  },

  dropPeer(pid) {
    if(this.conns[pid]) {
        this.conns[pid].close(); // 确保彻底关闭
        delete this.conns[pid];
        ui.renderList();
    }
  },

  flood(packet, excludeId) {
    Object.keys(this.conns).forEach(pid => {
      if(pid !== excludeId) {
          this.sendToConn(this.conns[pid], packet);
      }
    });
  },

  // 统一发送封装：带状态检查
  sendToConn(conn, packet) {
      if (conn && conn.open) {
          try {
              conn.send(packet);
          } catch (e) {
              console.error('Send fail:', e);
              this.dropPeer(conn.peer); // 发送失败直接踢掉重连
          }
      }
  },

  sendText(txt, targetId) {
    const id = Date.now() + Math.random().toString(36);
    const packet = {t: 'MSG', id, txt, sender: this.myName, target: targetId};
    this.seenMsgs.add(id);
    ui.appendMsg('我', txt, true);
    if(targetId === 'all') {
      this.flood(packet, null);
    } else {
      const c = this.conns[targetId];
      if(c && c.open) {
          this.sendToConn(c, packet);
      } else {
          alert('连接已断开，尝试重连中...');
          this.connectTo(targetId); // 尝试自动重连
      }
    }
  },

  sendFile(file, targetId) {
    const c = this.conns[targetId];
    if(!c || !c.open) { alert('未建立直连，无法传文件'); return; }
    const fid = Date.now() + '-' + Math.random();
    c.send({t: 'FILE_START', fid, meta: {name: file.name, size: file.size, type: file.type}});
    const reader = new FileReader();
    let offset = 0;
    reader.onload = e => {
      c.send({t: 'FILE_CHUNK', fid, data: e.target.result});
      offset += e.target.result.byteLength;
      if(offset < file.size) readNext();
      else ui.appendMsg('系统', `文件 ${file.name} 发送完毕`, true, true);
    };
    const readNext = () => reader.readAsArrayBuffer(file.slice(offset, offset + CHUNK_SIZE));
    readNext();
  },

  cleanup() {
    // 清理死链接
    Object.keys(this.conns).forEach(pid => {
      const c = this.conns[pid];
      // 如果超过 15 秒没心跳（或者没数据），且连接状态看着是 open，可能假死
      if (c.lastPing && (Date.now() - c.lastPing > 15000)) {
          this.log(`💀 ${pid.slice(0,6)} 心跳超时，断开`);
          this.dropPeer(pid);
      }
      if(!c.open) this.dropPeer(pid);
    });
  },

  // 发送心跳保活
  sendHeartbeat() {
      Object.values(this.conns).forEach(conn => {
          if(conn.open) conn.send({t: 'PING'});
      });
  },

  exchangePeers() {
    const list = [...Object.keys(this.conns)].slice(0, 20);
    const packet = {t: 'PEER_EX', list: list};
    Object.values(this.conns).forEach(c => { if(c.open) c.send(packet); });
  },
  
  checkNetworkHealth(force = false) {
    // 如果完全没连接，或者强制检查时
    if ((Object.keys(this.conns).length === 0 && !this.isSeed) || force) {
       SEEDS.forEach(s => this.connectTo(s));
    }
  }
};

// ===================== UI =====================
const ui = {
  activeChat: 'all',

  init() {
    document.getElementById('btnSend').onclick = () => {
      const el = document.getElementById('editor');
      if(el.innerText.trim()) {
        app.sendText(el.innerText.trim(), this.activeChat);
        el.innerText = '';
      }
    };
    
    document.getElementById('btnSave').onclick = () => {
      const nick = document.getElementById('iptNick').value;
      if(nick) {
        localStorage.setItem('nickname', nick);
        location.reload();
      }
      const peer = document.getElementById('iptPeer').value;
      if(peer) {
        app.connectTo(peer);
        alert('尝试连接: ' + peer);
        this.toggleSettings(false);
      }
    };
    
    document.getElementById('fileInput').onchange = (e) => {
      if(e.target.files[0]) app.sendFile(e.target.files[0], this.activeChat);
    };
    
    document.getElementById('btnBack').onclick = () => {
      document.getElementById('sidebar').classList.remove('hidden');
    };
    document.getElementById('btnToggleLog').onclick = () => {
      const el = document.getElementById('miniLog');
      el.style.display = el.style.display==='block'?'none':'block';
    };
    
    document.getElementById('iptNick').value = localStorage.getItem('nickname') || '';
    
    this.updateSelf();
    this.renderList();
  },

  toggleSettings(show) {
    document.getElementById('settings-panel').style.display = show ? 'grid' : 'none';
  },
  
  triggerFile() {
    if(this.activeChat === 'all') { alert('请先进入私聊再发文件'); return; }
    document.getElementById('fileInput').click();
  },

  updateSelf() {
    document.getElementById('myId').innerText = app.myId ? app.myId.slice(0,6) : '...';
    document.getElementById('statusText').innerText = app.isSeed ? '👑 入口' : '✅ 在线';
    document.getElementById('statusDot').className = 'dot ' + (app.myId ? 'online':'');
  },

  switchChat(pid) {
    this.activeChat = pid;
    const name = pid === 'all' ? '公共频道' : (app.conns[pid]?.label || pid.slice(0,6));
    document.getElementById('chatTitle').innerText = name;
    document.getElementById('chatStatus').innerText = pid === 'all' ? '全网广播' : (app.conns[pid]?'直连中':'未连接');
    document.getElementById('msgList').innerHTML = '<div class="sys-msg">切换到会话</div>';
    if(window.innerWidth < 768) document.getElementById('sidebar').classList.add('hidden');
    this.renderList();
  },

  renderList() {
    const list = document.getElementById('contactList');
    const count = Object.keys(app.conns).length;
    document.getElementById('onlineCount').innerText = count + ' 连接';

    let html = `
      <div class="contact-item ${this.activeChat==='all'?'active':''}" onclick="ui.switchChat('all')">
        <div class="avatar" style="background:#2a7cff">群</div>
        <div class="c-info">
          <div class="c-name">公共频道</div>
          <div class="c-msg">已与 ${count} 个设备互联</div>
        </div>
      </div>
    `;
    
    Object.keys(app.conns).forEach(pid => {
      const c = app.conns[pid];
      html += `
        <div class="contact-item ${this.activeChat===pid?'active':''}" onclick="ui.switchChat('${pid}')">
          <div class="avatar" style="background:#333">${(c.label||pid)[0]}</div>
          <div class="c-info">
            <div class="c-name">${c.label || pid.slice(0,6)}</div>
            <div class="c-msg" style="color:#22c55e">● 已连接</div>
          </div>
        </div>
      `;
    });

    app.knownPeers.forEach(pid => {
      if(!app.conns[pid] && pid !== app.myId) {
        html += `
          <div class="contact-item" style="opacity:0.5; cursor:default">
            <div class="avatar" style="background:#666">?</div>
            <div class="c-info">
              <div class="c-name">${pid.slice(0,6)}</div>
              <div class="c-msg">离线 / 未连接</div>
            </div>
          </div>
        `;
      }
    });

    list.innerHTML = html;
  },

  appendMsg(name, txt, isMe, isSys, isHtml) {
    const box = document.getElementById('msgList');
    const d = document.createElement('div');
    if(isSys) {
      d.className = 'sys-msg';
      d.innerText = txt;
    } else {
      d.className = `msg-row ${isMe?'me':'other'}`;
      const content = isHtml ? txt : txt.replace(/</g,'<').replace(/>/g,'>');
      d.innerHTML = `
        <div style="max-width:85%">
          <div class="msg-bubble">${content}</div>
          ${!isMe ? `<div class="msg-meta">${name}</div>` : ''}
        </div>`;
    }
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }
};

window.app = app;
window.ui = ui;
ui.init();
app.init();

})();