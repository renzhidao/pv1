(function(){
'use strict';

const CONFIG = {
  host: 'peerjs.92k.de', port: 443, secure: true, path: '/',
  config: { iceServers: [{urls:'stun:stun.l.google.com:19302'}] },
  debug: 0
};
const SEEDS = ['p1-s1', 'p1-s2', 'p1-s3'];
const CHUNK_SIZE = 64 * 1024;

// === 核心逻辑 ===
const app = {
  myId: localStorage.getItem('p1_fixed_id'),
  myName: localStorage.getItem('nickname') || 'User-'+Math.floor(Math.random()*1000),
  
  peer: null,
  conns: {}, // 活跃连接
  friends: JSON.parse(localStorage.getItem('p1_friends') || '{}'), // 通讯录
  msgs: JSON.parse(localStorage.getItem('p1_msgs') || '{"all":[]}'), // 消息
  seen: new Set(),
  
  log(s) {
    const el = document.getElementById('miniLog');
    if(el) el.innerText = s + '\n' + el.innerText.slice(0, 200);
  },

  init() {
    if (!this.myId) {
      this.myId = 'u-' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem('p1_fixed_id', this.myId);
    }
    
    this.start();
    
    // 强力守护
    setInterval(() => this.heal(), 3000);
    
    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState==='visible') { this.start(); this.heal(); }
    });
  },

  start() {
    if(this.peer && !this.peer.destroyed) return;
    
    try {
      const p = new Peer(this.myId, CONFIG);
      
      p.on('open', id => {
        this.myId = id;
        this.peer = p;
        ui.updateSelf();
        this.log('✅ 上线');
        this.heal();
      });

      p.on('connection', conn => this.setup(conn));
      p.on('error', err => {
        if(err.type === 'unavailable-id') setTimeout(() => this.start(), 2000);
      });
      this.peer = p;
    } catch(e) { this.log(e); }
  },

  heal() {
    if(!this.peer || this.peer.disconnected) {
      if(this.peer) this.peer.reconnect();
      return;
    }
    // 遍历所有朋友，断了就连
    Object.keys(this.friends).forEach(pid => {
      if (!this.conns[pid] || !this.conns[pid].open) this.connect(pid);
    });
    // 连种子
    SEEDS.forEach(s => {
      if(s !== this.myId && (!this.conns[s] || !this.conns[s].open)) this.connect(s);
    });
  },

  connect(id) {
    if(id === this.myId) return;
    if(this.peer) {
        const conn = this.peer.connect(id, {reliable: true});
        this.setup(conn);
    }
  },

  setup(conn) {
    const pid = conn.peer;
    conn.on('open', () => {
      this.conns[pid] = conn;
      conn.send({t: 'HELLO', n: this.myName});
      conn.send({t: 'PEER_EX', list: Object.keys(this.friends)});
      
      if(!this.friends[pid]) {
        this.friends[pid] = {name: pid.slice(0,6), lastSeen: Date.now(), unread: 0};
        this.saveFriends();
      }
      ui.renderList();
    });

    conn.on('data', d => {
      if(d.t === 'HELLO') {
        this.friends[pid].name = d.n;
        this.saveFriends();
        ui.renderList();
        if(ui.active === pid) document.getElementById('chatTitle').innerText = d.n;
      }
      
      if(d.t === 'PEER_EX') {
        d.list.forEach(id => {
          if(id !== this.myId && !this.friends[id]) {
            this.friends[id] = {name: id.slice(0,6), lastSeen: 0, unread: 0};
          }
        });
        this.saveFriends();
      }
      
      if(d.t === 'MSG') {
        if(this.seen.has(d.id)) return;
        this.seen.add(d.id);
        
        const key = d.target === 'all' ? 'all' : d.sender;
        if(d.target === 'all' || d.target === this.myId) {
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

  send(txt, targetId, isHtml) {
    const id = Date.now() + Math.random().toString();
    const pkt = {t: 'MSG', id, txt, name: this.myName, sender: this.myId, target: targetId, html: isHtml};
    this.seen.add(id);
    
    const key = targetId === 'all' ? 'all' : targetId;
    this.saveMsg(key, txt, true, '我', isHtml);
    
    if(targetId === 'all') {
      this.flood(pkt, null);
    } else {
      const c = this.conns[targetId];
      if(c && c.open) c.send(pkt);
      else this.connect(targetId);
    }
  },

  saveMsg(key, txt, me, name, html) {
    if(!this.msgs[key]) this.msgs[key] = [];
    this.msgs[key].push({txt, me, name, html});
    if(this.msgs[key].length > 50) this.msgs[key].shift();
    localStorage.setItem('p1_msgs', JSON.stringify(this.msgs));
    
    if(ui.active !== key) {
      if(!this.friends[key] && key!=='all') this.friends[key] = {name: name, unread: 0};
      if(this.friends[key]) this.friends[key].unread = (this.friends[key].unread||0) + 1;
      this.saveFriends();
      ui.renderList();
    } else {
      ui.renderMsgs();
    }
  },
  
  sendFile(file, targetId) {
    const reader = new FileReader();
    reader.onload = e => {
      const url = e.target.result; // Base64
      const html = `<div style="background:#333;padding:10px;border-radius:5px">
        <div>📄 ${file.name}</div>
        <a href="${url}" download="${file.name}" style="color:#4ade80;display:block;margin-top:5px">点击下载 (${(file.size/1024).toFixed(1)}KB)</a>
      </div>`;
      this.send(html, targetId, true);
    };
    reader.readAsDataURL(file);
  },
  
  saveFriends() { localStorage.setItem('p1_friends', JSON.stringify(this.friends)); }
};

// ===================== UI =====================
const ui = {
  active: 'all',

  init() {
    const bind = (id, fn) => { const el = document.getElementById(id); if(el) el.onclick = fn; };
    
    bind('btnSend', () => {
      const el = document.getElementById('editor');
      if(el.innerText) { app.send(el.innerText, this.active); el.innerText = ''; }
    });
    
    bind('btnFile', () => document.getElementById('fileInput').click());
    document.getElementById('fileInput').onchange = (e) => {
      if(e.target.files[0]) app.sendFile(e.target.files[0], this.active);
    };
    
    bind('btnSettings', () => {
        document.getElementById('settings-panel').style.display = 'grid';
        document.getElementById('iptNick').value = app.myName;
    });
    bind('btnCloseSettings', () => document.getElementById('settings-panel').style.display = 'none');
    bind('btnSave', () => {
        const n = document.getElementById('iptNick').value;
        if(n) { app.myName = n; localStorage.setItem('nickname', n); app.start(); }
        const p = document.getElementById('iptPeer').value;
        if(p) app.connect(p);
        document.getElementById('settings-panel').style.display = 'none';
    });
    bind('btnBack', () => document.getElementById('sidebar').classList.remove('hidden'));
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
    this.renderList();
    this.renderMsgs();
  },

  updateSelf() {
    document.getElementById('myId').innerText = app.myId.slice(0,6);
    document.getElementById('myNick').innerText = app.myName;
  },

  renderList() {
    const list = document.getElementById('contactList');
    const unreadAll = app.friends['all']?.unread || 0;
    
    let html = `
      <div class="contact-item ${this.active==='all'?'active':''}" onclick="ui.switch('all')">
        <div style="font-weight:bold">公共频道 ${unreadAll?'<span class="red-dot"></span>':''}</div>
      </div>
    `;
    
    Object.keys(app.friends).forEach(pid => {
      if(pid.includes('p1-seed') || pid === 'all') return;
      const f = app.friends[pid];
      const online = app.conns[pid] && app.conns[pid].open;
      html += `
        <div class="contact-item ${this.active===pid?'active':''}" onclick="ui.switch('${pid}')">
          <div>${f.name} ${f.unread?'<span class="red-dot"></span>':''}</div>
          <div style="font-size:10px;color:${online?'#4ade80':'#666'}">${online?'在线':'离线'}</div>
        </div>
      `;
    });
    list.innerHTML = html;
    document.getElementById('onlineCount').innerText = Object.keys(app.conns).length;
  },

  switch(pid) {
    this.active = pid;
    if(app.friends[pid]) app.friends[pid].unread = 0; 
    if(pid === 'all' && app.friends['all']) app.friends['all'].unread = 0;
    app.saveFriends();
    
    const name = pid === 'all' ? '公共频道' : app.friends[pid].name;
    document.getElementById('chatTitle').innerText = name;
    
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
  }
};

window.app = app;
window.ui = ui;
app.init();
setTimeout(() => ui.init(), 500);

})();