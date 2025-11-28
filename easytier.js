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
  
  // 🔥 核心数据结构：消息数据库 { peerId: [msg1, msg2...] }
  // 'all' 是公共频道
  msgs: JSON.parse(localStorage.getItem('p1_msgs') || '{"all":[]}'),
  seenMsgs: new Set(), // 去重
  
  fileChunks: {},
  isSeed: false,

  log(s) {
    const el = document.getElementById('miniLog');
    if(el) el.innerText = `[${new Date().toLocaleTimeString()}] ${s}\n` + el.innerText.slice(0, 200);
  },

  init() {
    this.start();
    setInterval(() => {
      this.cleanup();
      this.exchangePeers();
      if(Object.keys(this.conns).length === 0 && !this.isSeed) this.start();
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
        ui.updateSelf();
        this.log(`✅ 上线: ${myId.slice(0,5)}`);
        SEEDS.forEach(s => { if(s !== myId) this.connectTo(s); });
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
      conn.send({t: 'PEER_EX', list: [...this.knownPeers]});
    });

    conn.on('data', d => {
      if(d.t === 'HELLO') { conn.label = d.n; ui.renderList(); }
      if(d.t === 'PEER_EX') { d.list.forEach(id => this.remember(id)); ui.renderList(); }
      
      if(d.t === 'MSG') {
        if(this.seenMsgs.has(d.id)) return; 
        this.seenMsgs.add(d.id);
        
        // 📩 收到消息：存库 + 路由
        // 如果 target='all' -> 公共消息，存入 'all'
        // 如果 target=我 -> 私聊消息，存入 d.from (发送者)
        const chatId = d.target === 'all' ? 'all' : d.from;
        
        // 只有和我有关的消息才处理
        if(d.target === 'all' || d.target === this.myId) {
           this.saveMsg(chatId, d.txt, false, d.sender, d.isHtml);
        }
        
        // 帮忙转发 (只转发公共消息)
        if(d.target === 'all') this.flood(d, pid); 
      }
      
      // 文件处理 (简化：直接显示链接)
      if(d.t === 'FILE_CHUNK' && d.done) {
         const blob = new Blob([d.data], {type: d.meta.type});
         const url = URL.createObjectURL(blob);
         const link = `<a href="${url}" download="${d.meta.name}" style="color:#4ade80">📄 ${d.meta.name}</a>`;
         // 存入当前会话
         const chatId = ui.activeChat === 'all' ? 'all' : pid; 
         this.saveMsg(chatId, link, false, d.sender || conn.label, true);
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
    
    // 存自己的记录
    this.saveMsg(targetId, txt, true, '我');
    
    if(targetId === 'all') {
      this.flood(packet, null);
    } else {
      const c = this.conns[targetId];
      if(c && c.open) c.send(packet);
      else {
        this.connectTo(targetId);
        setTimeout(() => {
           if(this.conns[targetId]) this.conns[targetId].send(packet);
           else this.saveMsg(targetId, '离线，发送失败', true, '系统');
        }, 1500);
      }
    }
  },

  // 🔥 核心：消息存取与通知
  saveMsg(chatId, txt, isMe, senderName, isHtml) {
    if(!this.msgs[chatId]) this.msgs[chatId] = [];
    
    const msgObj = { txt, me: isMe, name: senderName, html: isHtml, time: Date.now() };
    this.msgs[chatId].push(msgObj);
    
    // 限制长度
    if(this.msgs[chatId].length > 50) this.msgs[chatId].shift();
    localStorage.setItem('p1_msgs', JSON.stringify(this.msgs));
    
    // 如果当前正开着这个窗口，直接上屏
    if(ui.activeChat === chatId) {
      ui.appendMsg(senderName, txt, isMe, false, isHtml);
    } else {
      // 否则，给这个联系人打上“有新消息”的标记（红点逻辑）
      ui.setUnread(chatId, true);
    }
  },

  sendFile(file, targetId) {
    // 简易单次发送（不分片，适合小文件，稳定）
    const reader = new FileReader();
    reader.onload = e => {
      const packet = { 
        t: 'FILE_CHUNK', 
        data: e.target.result, 
        meta: {name: file.name, type: file.type}, 
        done: true,
        sender: this.myName // 加上发送者名字
      };
      
      // 自己存一条
      this.saveMsg(targetId, `文件 ${file.name} 已发送`, true, '我');
      
      if(targetId === 'all') {
         Object.values(this.conns).forEach(c => c.send(packet));
      } else {
         if(this.conns[targetId]) this.conns[targetId].send(packet);
      }
    };
    reader.readAsArrayBuffer(file);
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

// ===================== UI =====================
const ui = {
  activeChat: 'all', 
  unread: {}, // { pid: true/false }

  init() {
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
    
    if(btnFile) btnFile.onclick = () => fileInput.click();
    if(fileInput) fileInput.onchange = (e) => {
      if(e.target.files[0]) app.sendFile(e.target.files[0], this.activeChat);
      e.target.value = ''; 
    };
    
    document.getElementById('btnBack').onclick = () => {
      document.getElementById('sidebar').classList.remove('hidden');
    };
    
    this.updateSelf();
    this.switchChat('all'); // 初始加载公共频道历史
  },

  updateSelf() {
    document.getElementById('myId').innerText = app.myId ? app.myId.slice(0,6) : '...';
    document.getElementById('statusText').innerText = app.isSeed ? '入口节点' : '普通节点';
    document.getElementById('statusDot').className = 'dot ' + (app.myId ? 'online':'');
  },

  switchChat(pid) {
    this.activeChat = pid;
    this.unread[pid] = false; // 清除红点
    
    // 尝试重连
    if(pid !== 'all' && !app.conns[pid]) app.connectTo(pid);

    const name = pid === 'all' ? '公共频道' : (app.conns[pid]?.label || pid.slice(0,6));
    document.getElementById('chatTitle').innerText = name;
    document.getElementById('chatStatus').innerText = pid === 'all' ? '全员' : (app.conns[pid]?'在线':'离线');
    
    // 🔥 关键：加载历史记录
    const msgBox = document.getElementById('msgList');
    msgBox.innerHTML = ''; // 清空旧的
    const history = app.msgs[pid] || [];
    if(history.length === 0) {
       msgBox.innerHTML = '<div class="sys-msg">暂无消息</div>';
    } else {
       history.forEach(m => this.appendMsg(m.name, m.txt, m.me, false, m.html));
    }
    
    if(window.innerWidth < 768) document.getElementById('sidebar').classList.add('hidden');
    this.renderList();
  },
  
  setUnread(pid, hasUnread) {
    this.unread[pid] = hasUnread;
    this.renderList(); // 刷新列表显示红点
  },

  renderList() {
    const list = document.getElementById('contactList');
    const count = Object.keys(app.conns).length;
    document.getElementById('onlineCount').innerText = count + ' 连接';

    let html = `
      <div class="contact-item ${this.activeChat==='all'?'active':''}" onclick="ui.switchChat('all')">
        <div class="avatar" style="background:#2a7cff">群</div>
        <div class="c-info">
          <div class="c-name">公共频道 ${this.unread['all']?'🔴':''}</div>
        </div>
      </div>
    `;
    
    const all = new Set([...Object.keys(app.conns), ...app.knownPeers, ...Object.keys(app.msgs)]);
    all.forEach(pid => {
      if(pid === app.myId || pid === 'all') return;
      
      const c = app.conns[pid];
      const isOnline = !!c;
      const label = c ? c.label : pid.slice(0,6);
      const hasRed = this.unread[pid] ? '🔴' : '';
      
      html += `
        <div class="contact-item ${this.activeChat===pid?'active':''}" onclick="ui.switchChat('${pid}')">
          <div class="avatar" style="background:${isOnline?'#22c55e':'#666'}">${label[0]}</div>
          <div class="c-info">
            <div class="c-name">${label} ${hasRed}</div>
            <div class="c-time" style="color:${isOnline?'#4ade80':'#666'}">${isOnline?'在线':'离线'}</div>
          </div>
        </div>
      `;
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

// 启动
window.app = app;
window.ui = ui;
app.init();
setTimeout(() => ui.init(), 100); 

})();