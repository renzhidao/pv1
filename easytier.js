(function(){
'use strict';

// ===================== 配置 =====================
const CONFIG = {
  host: 'peerjs.92k.de', port: 443, secure: true, path: '/',
  config: { iceServers: [{urls:'stun:stun.l.google.com:19302'}] },
  debug: 0
};
const MAX_NEIGHBORS = 50; 
const SEEDS = ['p1-s1', 'p1-s2', 'p1-s3']; 
const CHUNK_SIZE = 64 * 1024;

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

  log(s) {
    const el = document.getElementById('miniLog');
    if(el) el.innerText = `[${new Date().toLocaleTimeString()}] ${s}\n` + el.innerText.slice(0, 300);
  },

  init() {
    this.start();
    setInterval(() => {
      this.cleanup();
      this.exchangePeers();
      this.checkNetworkHealth();
    }, 5000);
    setInterval(() => this.seenMsgs.clear(), 60000);
  },

  start() {
    if(this.peer) return;
    const randIndex = Math.floor(Math.random() * SEEDS.length);
    this.initPeer(SEEDS[randIndex], true); 
  },

  initPeer(id, trySeed = false) {
    try {
      const p = new Peer(trySeed ? id : undefined, CONFIG);
      p.on('open', myId => {
        this.myId = myId;
        this.peer = p;
        this.isSeed = SEEDS.includes(myId);
        this.log(`✅ 就绪: ${myId.slice(0,6)}`);
        ui.updateSelf();
        SEEDS.forEach(s => { if(s !== myId) this.connectTo(s); });
      });
      p.on('error', err => {
        if(err.type === 'unavailable-id' && trySeed) this.initPeer(undefined, false);
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

  requestDirectConnection(targetId) {
    if(this.conns[targetId] && this.conns[targetId].open) {
      ui.switchChat(targetId); // 已经连了，直接切UI
      return;
    }
    this.log(`📡 呼叫反连: ${targetId.slice(0,6)}`);
    const packet = { t: 'CALL_ME', target: targetId, from: this.myId, id: Date.now()+Math.random() };
    this.flood(packet, null);
    this.connectTo(targetId);
    
    // UI 提示
    alert('正在呼叫对方建立直连通道，请稍候...');
  },

  handleConn(conn, isIncoming) {
    const pid = conn.peer;
    conn.on('open', () => {
      this.conns[pid] = conn;
      this.knownPeers.add(pid);
      ui.renderList();
      conn.send({t: 'HELLO', n: this.myName});
      const list = [...this.knownPeers, ...Object.keys(this.conns)];
      conn.send({t: 'PEER_EX', list: list});
      
      // 如果刚好在私聊这个人，更新标题状态
      if(ui.activeChat === pid) ui.switchChat(pid);
    });

    conn.on('data', d => {
      if(d.t === 'HELLO') { conn.label = d.n; ui.renderList(); }
      
      if(d.t === 'PEER_EX' && Array.isArray(d.list)) {
        d.list.forEach(id => {
          this.knownPeers.add(id);
          if (Object.keys(this.conns).length < 10 && id !== this.myId) this.connectTo(id);
        });
        ui.renderList(); // 刷新列表以显示新发现的潜在节点
      }
      
      if(d.t === 'CALL_ME') {
        if(d.target === this.myId) {
          this.log(`📩 反连请求: ${d.from.slice(0,6)}`);
          this.connectTo(d.from);
        } else {
          if(!this.seenMsgs.has(d.id)) { this.seenMsgs.add(d.id); this.flood(d, pid); }
        }
      }
      
      if(d.t === 'MSG') {
        if(this.seenMsgs.has(d.id)) return; 
        this.seenMsgs.add(d.id);
        
        // 只有公共消息或私聊给我的消息才显示
        if(d.target === 'all' || d.target === this.myId) {
          // 如果是私聊，要在 UI 上区分
          const isPrivate = d.target !== 'all';
          // 如果我在公共频道，只显示公共消息；如果我在私聊，只显示私聊
          if( (ui.activeChat === 'all' && !isPrivate) || (ui.activeChat === d.from && isPrivate) ) {
             ui.appendMsg(d.sender, d.txt, false, false, d.isHtml);
          } else if (isPrivate) {
             // 收到私聊但没打开窗口：这里简单弹个日志
             this.log(`🔔 收到 ${d.sender} 的私信`);
          }
        }
        
        // 转发 (只转发公共消息)
        if(d.target === 'all') this.flood(d, pid); 
      }
      
      // 文件逻辑
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

    conn.on('close', () => this.dropPeer(pid));
    conn.on('error', () => this.dropPeer(pid));
  },

  dropPeer(pid) {
    delete this.conns[pid];
    ui.renderList();
  },

  flood(packet, excludeId) {
    Object.keys(this.conns).forEach(pid => {
      if(pid !== excludeId && this.conns[pid].open) {
        try { this.conns[pid].send(packet); } catch(e){}
      }
    });
  },

  sendText(txt, targetId) {
    const id = Date.now() + Math.random().toString(36);
    const packet = {t: 'MSG', id, txt, sender: this.myName, target: targetId};
    this.seenMsgs.add(id);
    
    ui.appendMsg('我', txt, true);
    
    if(targetId === 'all') {
      this.flood(packet, null);
    } else {
      // 私聊直发
      const c = this.conns[targetId];
      if(c && c.open) c.send(packet);
      else alert('未连接此人');
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
    Object.keys(this.conns).forEach(pid => {
      if(!this.conns[pid].open) this.dropPeer(pid);
    });
  },

  exchangePeers() {
    const list = [...Object.keys(this.conns)].slice(0, 20);
    const packet = {t: 'PEER_EX', list: list};
    Object.values(this.conns).forEach(c => { if(c.open) c.send(packet); });
  },
  
  checkNetworkHealth() {
    if (Object.keys(this.conns).length === 0 && !this.isSeed) {
       SEEDS.forEach(s => this.connectTo(s));
    }
  }
};

// ===================== UI (修复点击切换) =====================
const ui = {
  activeChat: 'all', // 当前聊天对象

  init() {
    // 发送
    document.getElementById('btnSend').onclick = () => {
      const el = document.getElementById('editor');
      if(el.innerText.trim()) {
        app.sendText(el.innerText.trim(), this.activeChat);
        el.innerText = '';
      }
    };
    // 文件
    document.getElementById('btnFile').onclick = () => {
      if(this.activeChat === 'all') { alert('请先进入私聊再发文件'); return; }
      document.getElementById('fileInput').click();
    };
    document.getElementById('fileInput').onchange = (e) => {
      if(e.target.files[0]) app.sendFile(e.target.files[0], this.activeChat);
    };
    
    document.getElementById('btnBack').onclick = () => {
      document.getElementById('sidebar').classList.remove('hidden');
    };
    
    this.updateSelf();
    this.renderList();
  },

  updateSelf() {
    document.getElementById('myId').innerText = app.myId ? app.myId.slice(0,6) : '...';
    document.getElementById('statusText').innerText = app.isSeed ? '👑 入口' : '✅ 节点';
    document.getElementById('statusDot').className = 'dot ' + (app.myId ? 'online':'');
  },

  // 🔥 切换聊天窗口
  switchChat(pid) {
    this.activeChat = pid;
    
    // 更新标题
    const name = pid === 'all' ? '公共频道' : (app.conns[pid]?.label || pid.slice(0,6));
    document.getElementById('chatTitle').innerText = name;
    document.getElementById('chatStatus').innerText = pid === 'all' ? '全网广播' : (app.conns[pid]?'直连中':'未连接');
    
    // 清空消息 (暂不加载历史，保证性能)
    document.getElementById('msgList').innerHTML = '<div class="sys-msg">切换到会话</div>';
    
    // 移动端收起侧边栏
    if(window.innerWidth < 768) document.getElementById('sidebar').classList.add('hidden');
    
    // 高亮更新
    this.renderList();
  },

  renderList() {
    const list = document.getElementById('contactList');
    const count = Object.keys(app.conns).length;
    document.getElementById('onlineCount').innerText = count + ' 连接';

    // 1. 公共频道 (始终置顶)
    let html = `
      <div class="contact-item ${this.activeChat==='all'?'active':''}" onclick="ui.switchChat('all')">
        <div class="avatar" style="background:#2a7cff">群</div>
        <div class="c-info">
          <div class="c-name">公共频道</div>
          <div class="c-msg">已与 ${count} 个设备互联</div>
        </div>
      </div>
    `;
    
    // 2. 已连接节点
    Object.keys(app.conns).forEach(pid => {
      const c = app.conns[pid];
      html += `
        <div class="contact-item ${this.activeChat===pid?'active':''}" onclick="ui.switchChat('${pid}')">
          <div class="avatar" style="background:#333">${(c.label||pid)[0]}</div>
          <div class="c-info">
            <div class="c-name">${c.label || pid.slice(0,6)}</div>
            <div class="c-msg">已直连</div>
          </div>
        </div>
      `;
    });

    // 3. 潜在节点 (我知道但没连上)
    app.knownPeers.forEach(pid => {
      if(!app.conns[pid] && pid !== app.myId) {
        html += `
          <div class="contact-item" style="opacity:0.5" onclick="app.requestDirectConnection('${pid}')">
            <div class="avatar" style="background:#666">?</div>
            <div class="c-info">
              <div class="c-name">${pid.slice(0,6)}</div>
              <div class="c-msg">点击呼叫...</div>
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