(function(){
'use strict';

// ===================== 配置 =====================
const CONFIG = {
  host: 'peerjs.92k.de', port: 443, secure: true, path: '/',
  config: { iceServers: [{urls:'stun:stun.l.google.com:19302'}] },
  debug: 0
};
const SEEDS = ['p1-s1', 'p1-s2', 'p1-s3']; 
const CHUNK_SIZE = 64 * 1024;

// ===================== 核心逻辑 =====================
const app = {
  myId: '',
  myName: localStorage.getItem('nickname') || 'User-'+Math.floor(Math.random()*10000),
  peer: null,
  conns: {}, 
  knownPeers: new Set(JSON.parse(localStorage.getItem('p1_peers')||'[]')), 
  seenMsgs: new Set(),
  fileChunks: {},
  isSeed: false,

  log(s) {
    const el = document.getElementById('miniLog');
    if(el) el.innerText = `[${new Date().toLocaleTimeString()}] ${s}\n` + el.innerText.slice(0, 200);
  },

  init() {
    // 1. 启动网络
    this.start();
    
    // 2. 守护进程
    setInterval(() => {
      this.cleanup();
      this.exchangePeers();
      if(Object.keys(this.conns).length === 0 && !this.isSeed) this.start(); // 掉线重连
    }, 5000);
    
    // 3. 消息指纹清理
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
        ui.updateSelf();
        this.log(`✅ 上线: ${myId.slice(0,5)}`);
        
        // 连种子
        SEEDS.forEach(s => { if(s !== myId) this.connectTo(s); });
        // 连历史好友 (自动恢复连接)
        this.knownPeers.forEach(pid => this.connectTo(pid));
      });

      p.on('error', err => {
        if(err.type === 'unavailable-id' && trySeed) this.initPeer(undefined, false);
      });

      p.on('connection', conn => this.handleConn(conn, true));
    } catch(e) { this.log('ERR:'+e); }
  },

  connectTo(targetId) {
    if(targetId === this.myId || this.conns[targetId]) return;
    const conn = this.peer.connect(targetId, {reliable: true});
    this.handleConn(conn, false);
  },

  handleConn(conn, isIncoming) {
    const pid = conn.peer;
    
    conn.on('open', () => {
      this.conns[pid] = conn;
      this.remember(pid);
      ui.renderList();
      conn.send({t: 'HELLO', n: this.myName});
      // 交换通讯录
      conn.send({t: 'PEER_EX', list: [...this.knownPeers]});
    });

    conn.on('data', d => {
      if(d.t === 'HELLO') { conn.label = d.n; ui.renderList(); }
      
      if(d.t === 'PEER_EX' && Array.isArray(d.list)) {
        d.list.forEach(id => this.remember(id));
        ui.renderList();
      }
      
      if(d.t === 'MSG') {
        if(this.seenMsgs.has(d.id)) return; 
        this.seenMsgs.add(d.id);
        
        // UI显示规则：群聊全显，私聊只显相关
        if(d.target === 'all' || d.target === this.myId) {
           const isPrivate = d.target !== 'all';
           if( (ui.activeChat === 'all' && !isPrivate) || (ui.activeChat === d.from && isPrivate) ) {
              ui.appendMsg(d.sender, d.txt, false, false, d.isHtml);
           }
        }
        if(d.target === 'all') this.flood(d, pid); 
      }
      
      // 文件接收
      if(d.t === 'FILE_START') {
        this.fileChunks[d.fid] = { meta: d.meta, buffer: [], received: 0 };
        if(ui.activeChat === pid || ui.activeChat === 'all') ui.appendMsg('系统', `正在接收 ${d.meta.name}...`, false, true);
      }
      if(d.t === 'FILE_CHUNK') {
        const f = this.fileChunks[d.fid];
        if(f) {
          f.buffer.push(d.data);
          f.received += d.data.byteLength;
          if(f.received >= f.meta.size) {
            const blob = new Blob(f.buffer, {type: f.meta.type});
            const url = URL.createObjectURL(blob);
            // 在当前窗口显示下载链接（无论是群发还是私聊）
            if(ui.activeChat === pid || ui.activeChat === 'all') {
               ui.appendMsg(conn.label||pid.slice(0,5), `<a href="${url}" download="${f.meta.name}" style="color:#4ade80">📄 ${f.meta.name}</a>`, false, false, true);
            }
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
      const c = this.conns[targetId];
      if(c && c.open) c.send(packet);
      else {
        // 尝试重连并发送
        this.connectTo(targetId);
        setTimeout(() => {
           if(this.conns[targetId]) this.conns[targetId].send(packet);
           else ui.appendMsg('系统', '离线，发送失败', true, true);
        }, 1500);
      }
    }
  },

  // 🔥 群发文件支持：对所有邻居逐个发送
  sendFile(file, targetId) {
    const fid = Date.now() + '-' + Math.random();
    const meta = {name: file.name, size: file.size, type: file.type};
    
    // 确定发送目标列表
    let targets = [];
    if(targetId === 'all') {
      targets = Object.values(this.conns).filter(c => c.open);
      ui.appendMsg('我', `正在向 ${targets.length} 人群发文件...`, true, true);
    } else {
      const c = this.conns[targetId];
      if(c && c.open) targets = [c];
      else {
        this.connectTo(targetId); // 尝试重连
        ui.appendMsg('系统', '对方离线，尝试连接...', true, true);
        return;
      }
    }

    if(targets.length === 0) return;

    // 读取一次，多次发送
    const reader = new FileReader();
    let offset = 0;
    
    // 先发头
    targets.forEach(c => c.send({t: 'FILE_START', fid, meta}));

    reader.onload = e => {
      const chunk = e.target.result;
      targets.forEach(c => c.send({t: 'FILE_CHUNK', fid, data: chunk}));
      
      offset += chunk.byteLength;
      if(offset < file.size) {
        readNext();
      } else {
        ui.appendMsg('系统', `文件 ${file.name} 发送完毕`, true, true);
      }
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
    const list = [...this.knownPeers].slice(0, 50);
    const packet = {t: 'PEER_EX', list};
    Object.values(this.conns).forEach(c => { if(c.open) c.send(packet); });
  },
  
  remember(pid) {
    if(pid && pid !== this.myId) {
      this.knownPeers.add(pid);
      localStorage.setItem('p1_peers', JSON.stringify([...this.knownPeers]));
    }
  }
};

// ===================== UI (极简 & 健壮) =====================
const ui = {
  activeChat: 'all', 

  init() {
    // 确保按钮能点：直接绑定，不加 try-catch 包裹，方便暴露错误
    const btnSend = document.getElementById('btnSend');
    const btnFile = document.getElementById('btnFile');
    const fileInput = document.getElementById('fileInput');
    
    if(btnSend) btnSend.onclick = () => {
      const el = document.getElementById('editor');
      if(el.innerText.trim()) {
        app.sendText(el.innerText.trim(), this.activeChat);
        el.innerText = '';
      }
    };
    
    if(btnFile) btnFile.onclick = () => {
      fileInput.click();
    };
    
    if(fileInput) fileInput.onchange = (e) => {
      if(e.target.files[0]) app.sendFile(e.target.files[0], this.activeChat);
      e.target.value = ''; // 重置，允许重复发同一文件
    };
    
    document.getElementById('btnBack').onclick = () => {
      document.getElementById('sidebar').classList.remove('hidden');
    };
    
    this.updateSelf();
    this.renderList();
  },

  updateSelf() {
    document.getElementById('myId').innerText = app.myId ? app.myId.slice(0,6) : '...';
    document.getElementById('statusText').innerText = app.isSeed ? '入口节点' : '普通节点';
    document.getElementById('statusDot').className = 'dot ' + (app.myId ? 'online':'');
  },

  switchChat(pid) {
    this.activeChat = pid;
    
    // 点击离线头像，尝试重连
    if(pid !== 'all' && !app.conns[pid]) {
      app.connectTo(pid);
      document.getElementById('chatStatus').innerText = '连接中...';
    } else {
      document.getElementById('chatStatus').innerText = pid === 'all' ? '全员' : '在线';
    }

    const name = pid === 'all' ? '公共频道' : (app.conns[pid]?.label || pid.slice(0,6));
    document.getElementById('chatTitle').innerText = name;
    document.getElementById('msgList').innerHTML = '<div class="sys-msg">切换会话</div>';
    
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
        <div class="c-info"><div class="c-name">公共频道</div></div>
      </div>
    `;
    
    // 合并显示：在线的 + 历史记录的
    const all = new Set([...Object.keys(app.conns), ...app.knownPeers]);
    all.forEach(pid => {
      if(pid === app.myId) return;
      
      const c = app.conns[pid];
      const isOnline = !!c;
      const label = c ? c.label : pid.slice(0,6);
      
      html += `
        <div class="contact-item ${this.activeChat===pid?'active':''}" onclick="ui.switchChat('${pid}')">
          <div class="avatar" style="background:${isOnline?'#22c55e':'#666'}">${label[0]}</div>
          <div class="c-info">
            <div class="c-name">${label}</div>
            <div class="c-time" style="color:${isOnline?'#4ade80':'#666'}">${isOnline?'在线':'离线'}</div>
          </div>
        </div>
      `;
    });

    list.innerHTML = html;
  },

  appendMsg(name, txt, isMe, isSys, isHtml) {
    const box = document.getElementById('msgList');
    // 防卡顿：超过100条删旧
    if(box.childElementCount > 100) box.removeChild(box.firstElementChild);

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

// 启动
window.app = app;
window.ui = ui;
app.init();
// 延迟一点绑定 UI，确保 DOM 加载完（虽然放在 body 底部已经是安全的）
setTimeout(() => ui.init(), 100); 

})();