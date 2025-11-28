(function(){
'use strict';

// ===================== 核心配置 =====================
const CONFIG = {
  host: 'peerjs.92k.de', port: 443, secure: true, path: '/',
  config: { iceServers: [{urls:'stun:stun.l.google.com:19302'}] },
  debug: 0
};
// 每个人只维护 10 个连接（保证不卡，但通过泛洪能通全网）
const MAX_NEIGHBORS = 10; 
// 3 个固定入口，用于冷启动
const SEEDS = ['p1-seed-alpha', 'p1-seed-beta', 'p1-seed-gamma'];
const CHUNK_SIZE = 64 * 1024;

// ===================== 核心逻辑 (Mesh + 固定ID) =====================
const app = {
  // 1. 固定身份 (解决刷新变人问题)
  myId: localStorage.getItem('p1_fixed_id'),
  myName: localStorage.getItem('nickname') || 'User-'+Math.floor(Math.random()*10000),
  
  peer: null,
  conns: {}, // 仅存储直连邻居
  knownPeers: new Set(JSON.parse(localStorage.getItem('p1_peers')||'[]')), // 通讯录
  seenMsgs: new Set(), // 消息去重指纹
  msgs: JSON.parse(localStorage.getItem('p1_msgs') || '{"all":[]}'), // 聊天记录
  
  fileChunks: {},
  isSeed: false,

  log(s) {
    const el = document.getElementById('miniLog');
    if(el) el.innerText = `[${new Date().toLocaleTimeString()}] ${s}\n` + el.innerText.slice(0, 200);
  },

  init() {
    // 如果是第一次来，生成一个永久 ID
    if (!this.myId) {
      // 尝试抢占种子位（如果是新设备）
      // 但为了简单，我们先随机生成，启动后再看是否需要变身
      this.myId = 'u-' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem('p1_fixed_id', this.myId);
    }

    this.start();
    
    // 守护进程：每 5 秒维护一次网络
    setInterval(() => {
      this.cleanup();       // 踢掉死链
      this.maintainMesh();  // 缺人补人
      this.exchangePeers(); // 交换通讯录
    }, 5000);
    
    // 指纹清理
    setInterval(() => this.seenMsgs.clear(), 60000);
    
    // 唤醒重连
    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState === 'visible') {
        if(!this.peer || this.peer.disconnected) this.start();
        // 唤醒所有连接
        Object.values(this.conns).forEach(c => { try{c.send({t:'PING'})}catch(e){} });
      }
    });
  },

  start() {
    if(this.peer && !this.peer.destroyed) return;
    
    // 尝试抢占种子 ID (仅当我的固定 ID 已经是种子 ID 时，或者我想尝试上位)
    // 为了逻辑简单，我们优先用固定 ID。如果固定 ID 连不上，再考虑别的。
    
    try {
      const p = new Peer(this.myId, CONFIG);
      
      p.on('open', id => {
        this.myId = id;
        this.peer = p;
        this.isSeed = SEEDS.includes(id);
        ui.updateSelf();
        this.log(`✅ 上线: ${this.myName}`);
        
        // 1. 连种子 (骨干网)
        SEEDS.forEach(s => { if(s !== id) this.connectTo(s); });
        
        // 2. 连老朋友 (死循环回拨的核心)
        this.knownPeers.forEach(pid => this.connectTo(pid));
      });

      p.on('error', err => {
        // 关键：如果 ID 被占了 (unavailable-id)，说明我在另一个页面打开了，或者没退干净
        // 这时候不能换 ID (因为要固定)，只能重试
        if(err.type === 'unavailable-id') {
          this.log('ID 冲突，2秒后重试...');
          setTimeout(() => this.start(), 2000);
        } else {
          this.log('ERR: ' + err.type);
        }
      });

      p.on('connection', conn => this.handleConn(conn, true));
    } catch(e) { this.log('启动失败:'+e); }
  },

  // 建立连接 (带上限控制)
  connectTo(targetId) {
    if(targetId === this.myId || this.conns[targetId]) return;
    // 超过 10 个邻居就不主动连了，除非连种子
    if(Object.keys(this.conns).length >= MAX_NEIGHBORS && !SEEDS.includes(targetId)) return;
    
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
      // Gossip: 把我认识的人告诉你
      conn.send({t: 'PEER_EX', list: [...this.knownPeers]});
    });

    conn.on('data', d => {
      if(d.t === 'PING') return;
      
      if(d.t === 'HELLO') { 
        conn.label = d.n; 
        ui.renderList(); 
        if(ui.activeChat === pid) ui.switchChat(pid);
      }
      
      // 收到别人的通讯录 -> 记下来
      if(d.t === 'PEER_EX' && Array.isArray(d.list)) {
        d.list.forEach(id => this.remember(id));
        // 这里不立即连，交给 maintainMesh 统一调度，防止瞬间爆炸
      }
      
      // 收到消息 -> 显示 + 转发 (Mesh 核心)
      if(d.t === 'MSG') {
        if(this.seenMsgs.has(d.id)) return; // 见过，丢弃
        this.seenMsgs.add(d.id); // 标记
        
        // 存 + 显
        const key = d.target === 'all' ? 'all' : d.sender; // d.sender 是源头 ID
        // 如果是群聊，或者发给我的私聊
        if(d.target === 'all' || d.target === this.myId) {
           this.saveMsg(key, d.txt, false, d.senderName, d.isHtml);
        }
        
        // 转发 (只转发群聊)
        if(d.target === 'all') this.flood(d, pid); 
      }
      
      // 文件处理
      if(d.t === 'FILE_START') {
        this.fileChunks[d.fid] = { meta: d.meta, buffer: [], received: 0 };
        const name = d.senderName || conn.label || '未知';
        ui.appendMsg(name, `📥 正在接收 ${d.meta.name}...`, false, true);
      }
      if(d.t === 'FILE_CHUNK') {
        const f = this.fileChunks[d.fid];
        if(f) {
          f.buffer.push(d.data);
          f.received += d.data.byteLength;
          if(f.received >= f.meta.size) {
            const blob = new Blob(f.buffer, {type: f.meta.type});
            const url = URL.createObjectURL(blob);
            const html = `<div class="file-card"><a href="${url}" download="${f.meta.name}" style="color:#fff">📄 ${f.meta.name} (下载)</a></div>`;
            
            const name = d.senderName || conn.label;
            // 文件归档到当前窗口
            const chatKey = (ui.activeChat === 'all') ? 'all' : pid;
            this.saveMsg(chatKey, html, false, name, true);
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

  // 泛洪转发：除了来源，发给所有人
  flood(packet, excludeId) {
    Object.keys(this.conns).forEach(pid => {
      if(pid !== excludeId && this.conns[pid].open) {
        try { this.conns[pid].send(packet); } catch(e){}
      }
    });
  },

  sendText(txt, targetId) {
    const id = Date.now() + Math.random().toString(36);
    // 消息包结构：id(指纹), txt, sender(我ID), senderName(我名), target(目标)
    const packet = {t: 'MSG', id, txt, sender: this.myId, senderName: this.myName, target: targetId};
    this.seenMsgs.add(id);
    
    this.saveMsg(targetId, txt, true, '我');
    
    if(targetId === 'all') {
      this.flood(packet, null); // 群发
    } else {
      // 私聊：优先直连
      const c = this.conns[targetId];
      if(c && c.open) {
        c.send(packet);
      } else {
        // 没直连？尝试拨号
        this.connectTo(targetId);
        ui.appendMsg('系统', '正在建立直连...', true, true);
        setTimeout(() => {
           if(this.conns[targetId]) this.conns[targetId].send(packet);
        }, 2000);
      }
    }
  },

  saveMsg(chatKey, txt, isMe, senderName, isHtml) {
    // 归一化 Key
    if(!chatKey) chatKey = 'all';
    
    if(!this.msgs[chatKey]) this.msgs[chatKey] = [];
    const msgObj = { txt, me: isMe, name: senderName, html: isHtml, time: Date.now() };
    this.msgs[chatKey].push(msgObj);
    
    if(this.msgs[chatKey].length > 50) this.msgs[chatKey].shift();
    localStorage.setItem('p1_msgs', JSON.stringify(this.msgs));
    
    if(ui.activeChat === chatKey) {
      ui.appendMsg(senderName, txt, isMe, false, isHtml);
    } else {
      ui.setUnread(chatKey, true);
    }
  },

  sendFile(file, targetId) {
    const fid = Date.now() + '-' + Math.random();
    const meta = {name: file.name, size: file.size, type: file.type};
    
    const html = `<div class="file-card">📄 ${file.name} (已发送)</div>`;
    this.saveMsg(targetId, html, true, '我', true);

    // 目标列表
    let targets = [];
    if(targetId === 'all') targets = Object.values(this.conns).filter(c => c.open); // 伪群发：发给所有直连
    else {
      const c = this.conns[targetId];
      if(c && c.open) targets = [c];
      else { this.connectTo(targetId); return; }
    }

    if(targets.length === 0) return;

    targets.forEach(c => c.send({t: 'FILE_START', fid, meta, senderName: this.myName}));

    const reader = new FileReader();
    let offset = 0;
    reader.onload = e => {
      const chunk = e.target.result;
      targets.forEach(c => c.send({t: 'FILE_CHUNK', fid, data: chunk, senderName: this.myName, done: (offset+chunk.byteLength >= file.size)}));
      offset += chunk.byteLength;
      if(offset < file.size) setTimeout(readNext, 5);
    };
    const readNext = () => reader.readAsArrayBuffer(file.slice(offset, offset + CHUNK_SIZE));
    readNext();
  },

  cleanup() {
    Object.keys(this.conns).forEach(pid => { if(!this.conns[pid].open) this.dropPeer(pid); });
  },

  // 🕸️ 自动维护 Mesh 网络
  maintainMesh() {
    // 如果连接数太少（< 3），从通讯录里随机摇人
    if(Object.keys(this.conns).length < 3) {
      const list = Array.from(this.knownPeers);
      if(list.length > 0) {
        const randomId = list[Math.floor(Math.random() * list.length)];
        this.connectTo(randomId);
      }
      // 同时也去连种子
      SEEDS.forEach(s => { if(s !== this.myId) this.connectTo(s); });
    }
  },

  exchangePeers() {
    const list = [...this.knownPeers].slice(0, 20);
    const packet = {t: 'PEER_EX', list};
    Object.values(this.conns).forEach(c => { if(c.open) c.send(packet); });
  },
  
  remember(pid) {
    if(pid && pid !== this.myId) {
      this.knownPeers.add(pid);
      localStorage.setItem('p1_peers', JSON.stringify([...this.knownPeers]));
    }
  },
  
  requestWakeLock() {
    if('wakeLock' in navigator) navigator.wakeLock.request('screen').catch(()=>{});
  }
};

// ===================== UI (稳定版) =====================
const ui = {
  activeChat: 'all', 
  unread: {}, 

  init() {
    const btnSend = document.getElementById('btnSend');
    if(btnSend) {
      btnSend.onclick = () => {
        const el = document.getElementById('editor');
        if(el.innerText.trim()) {
          app.sendText(el.innerText.trim(), this.activeChat);
          el.innerText = '';
        }
      };
    }

    const btnFile = document.getElementById('btnFile');
    const fileInput = document.getElementById('fileInput');
    if(btnFile) {
      btnFile.onclick = () => fileInput.click();
      fileInput.onchange = (e) => {
        if(e.target.files[0]) {
          app.sendFile(e.target.files[0], this.activeChat);
          e.target.value = '';
        }
      };
    }

    // 侧边栏 & 设置
    const btnSet = document.getElementById('btnSettings');
    const panel = document.getElementById('settings-panel');
    if(btnSet) {
      btnSet.onclick = () => {
        document.getElementById('iptNick').value = app.myName;
        panel.style.display = 'grid';
      };
      document.getElementById('btnCloseSettings').onclick = () => panel.style.display='none';
      document.getElementById('btnSave').onclick = () => {
        const newName = document.getElementById('iptNick').value.trim();
        if(newName) {
          app.myName = newName;
          localStorage.setItem('nickname', newName);
          ui.updateSelf();
          Object.values(app.conns).forEach(c => c.send({t:'HELLO', n: newName}));
        }
        const peer = document.getElementById('iptPeer').value.trim();
        if(peer) app.connectTo(peer);
        panel.style.display = 'none';
      };
    }

    document.getElementById('btnBack').onclick = () => document.getElementById('sidebar').classList.remove('hidden');
    document.getElementById('btnToggleLog').onclick = () => {
       const el = document.getElementById('miniLog');
       el.style.display = el.style.display==='block' ? 'none' : 'block';
    };

    // 注入安装按钮和样式
    if(!document.getElementById('dynamic-style')) {
      const s = document.createElement('style');
      s.id = 'dynamic-style';
      s.innerHTML = `.file-card { background: #232634; padding: 8px; border-radius: 8px; display: flex; align-items: center; gap: 8px; min-width: 180px; color: #fff; }`;
      document.head.appendChild(s);
    }
    
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      window.deferredPrompt = e;
      const btn = document.createElement('div');
      btn.className = 'btn-icon';
      btn.innerHTML = '📲';
      btn.onclick = () => { window.deferredPrompt.prompt(); btn.remove(); };
      document.querySelector('.chat-header').appendChild(btn);
    });

    this.updateSelf();
    this.switchChat('all');
  },

  updateSelf() {
    document.getElementById('myId').innerText = app.myId ? app.myId.slice(0,6) : '...';
    document.getElementById('myNick').innerText = app.myName;
    document.getElementById('statusText').innerText = app.isSeed ? '入口' : '节点';
    document.getElementById('statusDot').className = 'dot ' + (app.myId ? 'online':'');
  },

  switchChat(pid) {
    this.activeChat = pid;
    this.unread[pid] = false; 
    
    // 尝试重连
    if(pid !== 'all' && !app.conns[pid]) app.connectTo(pid);

    const name = pid === 'all' ? '公共频道' : (app.conns[pid]?.label || pid.slice(0,6));
    document.getElementById('chatTitle').innerText = name;
    document.getElementById('chatStatus').innerText = pid === 'all' ? 'Mesh 广播' : (app.conns[pid]?'在线':'离线');
    
    const msgBox = document.getElementById('msgList');
    msgBox.innerHTML = ''; 
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

window.app = app;
window.ui = ui;
app.init();
// 延迟绑定，避开 DOM 竞争
setTimeout(() => ui.init(), 500); 

})();