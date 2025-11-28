(function(){
'use strict';

const CONFIG = {
  host: 'peerjs.92k.de', port: 443, secure: true, path: '/',
  config: { iceServers: [{urls:'stun:stun.l.google.com:19302'}] },
  debug: 0
};
const SEEDS = ['p1-s1', 'p1-s2', 'p1-s3'];
const CHUNK = 64 * 1024;

// === 核心状态 ===
const app = {
  // 物理ID：PeerJS 每次可能变
  // 逻辑ID：存 localStorage，永不变，用于识别身份
  logicId: localStorage.getItem('p1_lid'), 
  myName: localStorage.getItem('p1_nick') || 'User-'+Math.floor(Math.random()*999),
  
  peer: null,
  conns: {}, // pid -> {conn, open}
  
  // 好友表：logicId -> {name, lastPid, unread}
  friends: JSON.parse(localStorage.getItem('p1_friends') || '{}'),
  
  msgs: JSON.parse(localStorage.getItem('p1_msgs') || '{"all":[]}'),
  seen: new Set(),
  isSeed: false,

  log(s) {
    const el = document.getElementById('miniLog');
    if(el) el.innerText = s + '\n' + el.innerText.slice(0, 200);
  },

  init() {
    if (!this.logicId) {
      this.logicId = 'u-' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem('p1_lid', this.logicId);
    }
    
    this.start();
    
    // 守护进程：每3秒尝试连接所有好友的“最后已知物理ID”和种子
    setInterval(() => this.heal(), 3000);
    
    // 消息去重清理
    setInterval(() => this.seen.clear(), 60000);
    
    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState==='visible') { this.start(); this.heal(); }
    });
  },

  start() {
    if(this.peer && !this.peer.destroyed) return;
    try {
      // 尝试用 logicId 作为物理 ID (如果没被占)
      const p = new Peer(this.logicId, CONFIG);
      
      p.on('open', id => {
        this.peer = p;
        this.isSeed = SEEDS.includes(id);
        this.log('✅ 上线: ' + id.slice(0,5));
        ui.updateSelf();
        this.heal();
      });

      p.on('connection', conn => this.setup(conn));
      p.on('error', err => {
        // 如果 ID 被占（说明我在另一个设备登录，或者上次没退），就用随机 ID
        if(err.type === 'unavailable-id') {
           this.log('ID冲突，切换随机...');
           const p2 = new Peer(CONFIG); // 随机
           this.bindPeer(p2);
        }
      });
      this.bindPeer(p);
    } catch(e) { this.log(e); }
  },
  
  bindPeer(p) {
    p.on('open', id => {
        this.peer = p;
        ui.updateSelf();
        this.heal();
    });
    p.on('connection', c => this.setup(c));
  },

  heal() {
    if(!this.peer || this.peer.disconnected) {
      if(this.peer) this.peer.reconnect();
      return;
    }
    // 连好友 (尝试连接他们最后一次使用的物理 ID)
    Object.values(this.friends).forEach(f => {
      // 如果有最后已知 ID，且没连上
      if (f.lastPid && (!this.conns[f.lastPid] || !this.conns[f.lastPid].open)) {
        this.connect(f.lastPid);
      }
      // 如果 logicId 本身就是物理 ID (理想情况)
      if (f.logicId && (!this.conns[f.logicId] || !this.conns[f.logicId].open)) {
        this.connect(f.logicId);
      }
    });
    
    // 连种子
    SEEDS.forEach(s => {
      if(s !== this.peer.id && (!this.conns[s] || !this.conns[s].open)) this.connect(s);
    });
  },

  connect(id) {
    if(id === this.peer.id) return;
    const conn = this.peer.connect(id, {reliable: true});
    this.setup(conn);
  },

  setup(conn) {
    const pid = conn.peer;
    conn.on('open', () => {
      this.conns[pid] = conn;
      // 握手：发送我的 逻辑ID 和 名字
      conn.send({t: 'HELLO', n: this.myName, lid: this.logicId});
      // Gossip: 交换朋友列表
      conn.send({t: 'PEER_EX', l: Object.keys(this.conns)});
      ui.renderList();
    });

    conn.on('data', d => {
      if(d.t === 'HELLO') {
        // 收到对方身份：更新好友表
        // 以 logicId 为准，更新 lastPid
        const lid = d.lid || pid; // 兼容旧版
        if(!this.friends[lid]) {
           this.friends[lid] = {name: d.n, lastPid: pid, unread: 0, logicId: lid};
        } else {
           this.friends[lid].name = d.n;
           this.friends[lid].lastPid = pid; // 更新物理地址
        }
        this.save();
        ui.renderList();
        if(ui.active === lid) document.querySelector('.ch-title').innerText = d.n;
      }
      
      if(d.t === 'PEER_EX') {
        d.l.forEach(id => {
           // 这里的 id 是物理 ID，不知道逻辑 ID，暂时只尝试连接
           if(id !== this.peer.id && !this.conns[id]) this.connect(id);
        });
      }
      
      if(d.t === 'MSG') {
        if(this.seen.has(d.id)) return;
        this.seen.add(d.id);
        
        // 路由：target 是逻辑 ID
        const key = d.target === 'all' ? 'all' : d.srcLid;
        if(d.target === 'all' || d.target === this.logicId) {
          this.saveMsg(key, d.txt, false, d.name, d.html);
        }
        if(d.target === 'all') this.flood(d, pid);
      }
    });

    conn.on('close', () => { delete this.conns[pid]; ui.renderList(); });
    conn.on('error', () => { delete this.conns[pid]; ui.renderList(); });
  },

  flood(pkt, exclude) {
    Object.keys(this.conns).forEach(pid => {
      if(pid !== exclude) { try { this.conns[pid].send(pkt); } catch(e){} }
    });
  },

  send(txt, targetLid, isHtml) {
    const id = Date.now() + Math.random().toString();
    const pkt = {t: 'MSG', id, txt, name: this.myName, srcLid: this.logicId, target: targetLid, html: isHtml};
    this.seen.add(id);
    
    const key = targetLid === 'all' ? 'all' : targetLid;
    this.saveMsg(key, txt, true, '我', isHtml);
    
    if(targetLid === 'all') {
      this.flood(pkt, null);
    } else {
      // 私聊：找到对应的物理连接
      const f = this.friends[targetLid];
      if (f && f.lastPid && this.conns[f.lastPid]) {
         this.conns[f.lastPid].send(pkt);
      } else {
         // 尝试重连
         if(f && f.lastPid) this.connect(f.lastPid);
         ui.appendMsg('系统', '离线，正在尝试重连...', true, false, false);
      }
    }
  },

  saveMsg(key, txt, me, name, html) {
    if(!this.msgs[key]) this.msgs[key] = [];
    this.msgs[key].push({txt, me, name, html});
    if(this.msgs[key].length > 60) this.msgs[key].shift();
    localStorage.setItem('p1_msgs', JSON.stringify(this.msgs));
    
    if(ui.active === key) ui.renderMsgs();
    else {
      if(this.friends[key]) this.friends[key].unread = (this.friends[key].unread||0) + 1;
      if(key === 'all') {
         if(!this.friends['all']) this.friends['all'] = {unread:0};
         this.friends['all'].unread = (this.friends['all'].unread||0)+1;
      }
      this.save();
      ui.renderList();
    }
  },
  
  sendFile(file, targetId) {
    const reader = new FileReader();
    reader.onload = e => {
      const url = e.target.result; 
      const html = `<div class="file-card">
        <div class="f-icon">📄</div>
        <div class="f-name">${file.name}</div>
        <a href="${url}" download="${file.name}" class="f-btn">下载</a>
      </div>`;
      this.send(html, targetId, true);
    };
    reader.readAsDataURL(file);
  },
  
  save() { localStorage.setItem('p1_friends', JSON.stringify(this.friends)); }
};

// === UI ===
const ui = {
  active: 'all',

  init() {
    const bind = (id, fn) => { 
      const el = document.getElementById(id); 
      if(el) el.onclick = fn; 
      else console.warn('UI Missing:', id);
    }
    
    bind('btnSend', () => {
      const el = document.getElementById('editor');
      if(el.innerText.trim()) { app.send(el.innerText, this.active); el.innerText=''; }
    });
    
    bind('btnFile', () => document.getElementById('fileInput').click());
    const fIn = document.getElementById('fileInput');
    if(fIn) fIn.onchange = (e) => {
      const f = e.target.files[0];
      if(f) app.sendFile(f, this.active);
    };
    
    bind('btnBack', () => document.getElementById('sidebar').classList.remove('hidden'));
    bind('btnSettings', () => {
        document.getElementById('settings-panel').style.display = 'grid';
        document.getElementById('iptNick').value = app.myName;
    });
    bind('btnCloseSettings', () => document.getElementById('settings-panel').style.display = 'none');
    bind('btnSave', () => {
        const n = document.getElementById('iptNick').value;
        if(n) { app.myName = n; localStorage.setItem('p1_nick', n); ui.updateSelf(); }
        const p = document.getElementById('iptPeer').value;
        if(p) app.connect(p);
        document.getElementById('settings-panel').style.display = 'none';
    });
    bind('btnToggleLog', () => {
       const el = document.getElementById('miniLog');
       el.style.display = el.style.display==='block'?'none':'block';
    });
    
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      window.deferredPrompt = e;
      const btn = document.createElement('div');
      btn.className = 'btn-icon';
      btn.innerText = '📲';
      btn.onclick = () => window.deferredPrompt.prompt();
      document.querySelector('.chat-header').appendChild(btn);
    });

    this.updateSelf();
    this.switch('all');
  },

  updateSelf() {
    document.getElementById('myId').innerText = app.myId ? app.myId.slice(0,6) : '...';
    document.getElementById('myNick').innerText = app.myName;
  },

  renderList() {
    const list = document.getElementById('contactList');
    const unreadAll = app.friends['all']?.unread || 0;
    
    let html = `
      <div class="contact-item ${this.active==='all'?'active':''}" onclick="ui.switch('all')">
        <div class="avatar" style="background:#2a7cff">群</div>
        <div class="c-info">
          <div class="c-name">公共频道</div>
          <div class="c-msg">全员广播</div>
        </div>
        ${unreadAll ? '<div class="red-dot"></div>' : ''}
      </div>`;
      
    // 渲染通讯录（逻辑ID）
    Object.keys(app.friends).forEach(lid => {
      if(lid.includes('p1-seed') || lid === 'all') return;
      const f = app.friends[lid];
      // 在线判定：必须有物理连接
      const online = f.lastPid && app.conns[f.lastPid] && app.conns[f.lastPid].open;
      
      html += `
        <div class="contact-item ${this.active===lid?'active':''} ${f.unread?'has-unread':''}" onclick="ui.switch('${lid}')">
          <div class="avatar" style="background:${online?'#22c55e':'#666'}">${f.name[0]}</div>
          <div class="c-info">
            <div class="c-name">${f.name}</div>
            <div class="c-msg" style="color:${online?'#4ade80':'#666'}">${online?'在线':'离线'}</div>
          </div>
          <div class="red-dot"></div>
        </div>`;
    });
    list.innerHTML = html;
    document.getElementById('onlineCount').innerText = Object.keys(app.conns).length + ' 连接';
  },

  switch(lid) {
    this.active = lid;
    if(app.friends[lid]) app.friends[lid].unread = 0; 
    if(lid === 'all' && app.friends['all']) app.friends['all'].unread = 0;
    app.save();
    
    const name = lid === 'all' ? '公共频道' : (app.friends[lid]?.name || lid.slice(0,5));
    document.querySelector('.ch-title').innerText = name;
    document.querySelector('.ch-status').innerText = lid === 'all' ? 'Mesh 广播' : (
      (app.friends[lid]?.lastPid && app.conns[app.friends[lid].lastPid]) ? '在线' : '离线'
    );
    
    if(window.innerWidth < 768) document.getElementById('sidebar').classList.add('hidden');
    this.renderList();
    this.renderMsgs();
  },

  renderMsgs() {
    const box = document.getElementById('msgList');
    box.innerHTML = '';
    const msgs = app.msgs[this.active] || [];
    msgs.forEach(m => {
      const content = m.html ? m.txt : m.txt.replace(/</g,'<');
      box.innerHTML += `
        <div class="msg-row ${m.me?'me':'other'}">
          <div class="msg-bubble">
            ${content}
            ${!m.me?`<div class="msg-meta">${m.name}</div>`:''}
          </div>
        </div>`;
    });
    box.scrollTop = box.scrollHeight;
  },
  
  appendMsg(name, txt, isMe, isSys, isHtml) {
    // 实时追加，不重绘
    const box = document.getElementById('msgList');
    const content = isHtml ? txt : txt.replace(/</g,'<');
    box.innerHTML += `
      <div class="msg-row ${isMe?'me':'other'}">
        <div class="msg-bubble">
          ${content}
          ${!isMe?`<div class="msg-meta">${name}</div>`:''}
        </div>
      </div>`;
    box.scrollTop = box.scrollHeight;
  }
};

// 启动
window.app = app;
window.ui = ui;
// 确保 DOM 加载
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ()=>app.init());
else { app.init(); setTimeout(()=>ui.init(), 100); }

})();