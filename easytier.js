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

// ===================== 核心 =====================
const app = {
  myId: '',
  myName: localStorage.getItem('nickname') || 'User-'+Math.floor(Math.random()*10000),
  peer: null,
  conns: {}, 
  
  // 数据库：名字为 Key
  contacts: JSON.parse(localStorage.getItem('p1_contacts') || '{}'), 
  msgs: JSON.parse(localStorage.getItem('p1_msgs') || '{"all":[]}'),
  
  seenMsgs: new Set(),
  fileChunks: {},
  isSeed: false,

  log(s) {
    const el = document.getElementById('miniLog');
    if(el) el.innerText = `[${new Date().toLocaleTimeString()}] ${s}\n` + el.innerText.slice(0, 200);
  },

  init() {
    this.start();
    
    // 守护进程
    setInterval(() => {
      this.cleanup();
      this.exchangePeers();
      // 掉线重连
      if(Object.keys(this.conns).length === 0 && !this.isSeed) this.start();
    }, 5000);
    
    setInterval(() => this.seenMsgs.clear(), 60000);
    
    // 🔥 唤醒暴力重连：彻底解决切后台“假死”问题
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.log('⚡ 唤醒检查...');
        this.requestWakeLock();
        // 如果信令断了，或者连接数归零，强制重启
        if (!this.peer || this.peer.disconnected || Object.keys(this.conns).length === 0) {
           this.start();
        }
        // 主动 Ping 所有连接，唤醒死链
        Object.values(this.conns).forEach(c => { try{c.send({t:'PING'})}catch(e){} });
      }
    });
  },

  start() {
    if(this.peer && !this.peer.destroyed) return;
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
        this.log(`✅ 上线: ${this.myName} (${myId.slice(0,5)})`);
        
        SEEDS.forEach(s => { if(s !== myId) this.connectTo(s); });
        // 重新连接所有熟人（取最新的 ID）
        Object.values(this.contacts).forEach(c => {
          if(c.id && c.id !== myId) this.connectTo(c.id);
        });
        
        this.requestWakeLock();
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
      ui.renderList();
      conn.send({t: 'HELLO', n: this.myName});
      // Gossip
      const list = Object.values(this.contacts).map(c => c.id).filter(id => id);
      conn.send({t: 'PEER_EX', list});
    });

    conn.on('data', d => {
      if(d.t === 'PING') return; // 心跳包
      
      if(d.t === 'HELLO') { 
        conn.label = d.n; 
        // 更新名册：名字 -> 最新 ID
        this.contacts[d.n] = { id: pid, lastSeen: Date.now() };
        localStorage.setItem('p1_contacts', JSON.stringify(this.contacts));
        ui.renderList();
        // 如果当前正在和该人聊天，刷新标题
        if(ui.activeChatName === d.n) ui.switchChat(d.n, pid);
      }
      
      if(d.t === 'PEER_EX') {
        d.list.forEach(id => {
          if(id !== this.myId && !this.conns[id] && Object.keys(this.conns).length < 15) this.connectTo(id);
        });
      }
      
      if(d.t === 'MSG') {
        if(this.seenMsgs.has(d.id)) return; 
        this.seenMsgs.add(d.id);
        
        const chatKey = d.target === 'all' ? 'all' : d.senderName;
        
        if(d.target === 'all' || d.target === this.myName) { 
           this.saveMsg(chatKey, d.txt, false, d.senderName, d.isHtml);
        }
        
        if(d.target === 'all') this.flood(d, pid); 
      }
      
      // 文件接收
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
            const chatKey = (ui.activeChatName === '公共频道') ? 'all' : name;
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

  flood(packet, excludeId) {
    Object.keys(this.conns).forEach(pid => {
      if(pid !== excludeId && this.conns[pid].open) {
        try { this.conns[pid].send(packet); } catch(e){}
      }
    });
  },

  sendText(txt, targetName) { 
    const id = Date.now() + Math.random().toString(36);
    const packet = {t: 'MSG', id, txt, senderName: this.myName, target: targetName === '公共频道' ? 'all' : targetName};
    this.seenMsgs.add(id);
    
    const storageKey = targetName === '公共频道' ? 'all' : targetName;
    this.saveMsg(storageKey, txt, true, '我');
    
    if(targetName === '公共频道') {
      this.flood(packet, null);
    } else {
      // 私聊：查 ID
      const contact = this.contacts[targetName];
      const targetId = contact ? contact.id : null;
      const c = this.conns[targetId];
      
      if(c && c.open) {
        c.send(packet);
      } else {
        // 尝试回拨
        if(targetId) this.connectTo(targetId);
        ui.appendMsg('系统', '对方暂时离线，正在呼叫...', true, true);
        // 稍微延迟重试一次
        setTimeout(() => {
           if(this.conns[targetId]) this.conns[targetId].send(packet);
        }, 2000);
      }
    }
  },

  saveMsg(chatKey, txt, isMe, senderName, isHtml) {
    if(!this.msgs[chatKey]) this.msgs[chatKey] = [];
    const msgObj = { txt, me: isMe, name: senderName, html: isHtml, time: Date.now() };
    this.msgs[chatKey].push(msgObj);
    if(this.msgs[chatKey].length > 50) this.msgs[chatKey].shift();
    localStorage.setItem('p1_msgs', JSON.stringify(this.msgs));
    
    if(ui.activeChatName === chatKey || (chatKey === 'all' && ui.activeChatName === '公共频道')) {
      ui.appendMsg(senderName, txt, isMe, false, isHtml);
    } else {
      ui.setUnread(chatKey, true);
    }
  },

  sendFile(file, targetName) {
    const fid = Date.now() + '-' + Math.random();
    const meta = {name: file.name, size: file.size, type: file.type};
    
    const html = `<div class="file-card">📄 ${file.name} (已发送)</div>`;
    const storageKey = targetName === '公共频道' ? 'all' : targetName;
    this.saveMsg(storageKey, html, true, '我', true);

    let targets = [];
    if(targetName === '公共频道') targets = Object.values(this.conns).filter(c => c.open);
    else {
      const cid = this.contacts[targetName]?.id;
      if(this.conns[cid]) targets = [this.conns[cid]];
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

  exchangePeers() {
    const list = Object.values(this.contacts).map(c => c.id).filter(id => id);
    const packet = {t: 'PEER_EX', list};
    Object.values(this.conns).forEach(c => { if(c.open) c.send(packet); });
  },
  
  remember(pid) {
    // 这里只做简单的 ID 记录，名字绑定在 HELLO 消息里做
  },
  
  requestWakeLock() {
    if('wakeLock' in navigator) navigator.wakeLock.request('screen').catch(()=>{});
  }
};

// ===================== UI =====================
const ui = {
  activeChatName: '公共频道', 
  activeChatId: null,       
  unread: {}, 

  init() {
    const btnSend = document.getElementById('btnSend');
    // 安全绑定：防止 DOM 还没加载完
    if(btnSend) {
      btnSend.onclick = () => {
        const el = document.getElementById('editor');
        if(el.innerText.trim()) {
          app.sendText(el.innerText.trim(), this.activeChatName);
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
          app.sendFile(e.target.files[0], this.activeChatName);
          e.target.value = '';
        }
      };
    }

    // 设置面板
    const btnSet = document.getElementById('btnSettings');
    const panel = document.getElementById('settings-panel');
    const btnSave = document.getElementById('btnSave');
    if(btnSet) {
      btnSet.onclick = () => {
        document.getElementById('iptNick').value = app.myName;
        panel.style.display = 'grid';
      };
      document.getElementById('btnCloseSettings').onclick = () => panel.style.display='none';
      btnSave.onclick = () => {
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

    // 注入样式
    if(!document.getElementById('dynamic-style')) {
      const s = document.createElement('style');
      s.id = 'dynamic-style';
      s.innerHTML = `.file-card { background: #232634; padding: 8px; border-radius: 8px; display: flex; align-items: center; gap: 8px; min-width: 180px; color: #fff; }`;
      document.head.appendChild(s);
    }

    this.updateSelf();
    this.switchChat('公共频道', null);
  },

  updateSelf() {
    document.getElementById('myId').innerText = app.myId ? app.myId.slice(0,6) : '...';
    document.getElementById('myNick').innerText = app.myName;
    document.getElementById('statusText').innerText = app.isSeed ? '入口节点' : '普通节点';
    document.getElementById('statusDot').className = 'dot ' + (app.myId ? 'online':'');
  },

  switchChat(name, id) {
    this.activeChatName = name;
    this.activeChatId = id;
    this.unread[name] = false; 
    
    if(id && !app.conns[id]) app.connectTo(id);

    document.getElementById('chatTitle').innerText = name;
    
    // 加载历史
    const key = name === '公共频道' ? 'all' : name;
    const msgBox = document.getElementById('msgList');
    msgBox.innerHTML = ''; 
    const history = app.msgs[key] || [];
    
    if(history.length === 0) {
       msgBox.innerHTML = '<div class="sys-msg">暂无消息</div>';
    } else {
       history.forEach(m => this.appendMsg(m.name, m.txt, m.me, false, m.html));
    }
    
    if(window.innerWidth < 768) document.getElementById('sidebar').classList.add('hidden');
    this.renderList();
  },
  
  setUnread(name, hasUnread) {
    this.unread[name] = hasUnread;
    this.renderList(); 
  },

  renderList() {
    const list = document.getElementById('contactList');
    const count = Object.keys(app.conns).length;
    document.getElementById('onlineCount').innerText = count + ' 连接';

    let html = `
      <div class="contact-item ${this.activeChatName==='公共频道'?'active':''}" onclick="ui.switchChat('公共频道', null)">
        <div class="avatar" style="background:#2a7cff">群</div>
        <div class="c-info">
          <div class="c-name">公共频道 ${this.unread['all']?'🔴':''}</div>
        </div>
      </div>
    `;
    
    const allNames = new Set([...Object.keys(app.contacts), ...Object.keys(app.conns).map(pid => app.conns[pid].label)]);
    
    allNames.forEach(name => {
      if(!name || name === app.myName) return;
      
      let id = null;
      const onlinePid = Object.keys(app.conns).find(pid => app.conns[pid].label === name);
      if(onlinePid) id = onlinePid;
      else if(app.contacts[name]) id = app.contacts[name].id;
      
      const isOnline = !!onlinePid;
      const hasRed = this.unread[name] ? '🔴' : '';
      
      html += `
        <div class="contact-item ${this.activeChatName===name?'active':''}" onclick="ui.switchChat('${name}', '${id}')">
          <div class="avatar" style="background:${isOnline?'#22c55e':'#666'}">${name[0]}</div>
          <div class="c-info">
            <div class="c-name">${name} ${hasRed}</div>
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
setTimeout(() => ui.init(), 500); 

})();