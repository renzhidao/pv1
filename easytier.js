(function(){
'use strict';

const CONFIG = {
  host: 'peerjs.92k.de', port: 443, secure: true, path: '/',
  config: { iceServers: [{urls:'stun:stun.l.google.com:19302'}] },
  debug: 0
};
const SEEDS = ['p1-s1', 'p1-s2', 'p1-s3'];
const CHUNK = 64 * 1024;

// 核心状态
const app = {
  myId: localStorage.getItem('p1_id'),
  myName: localStorage.getItem('p1_nick') || 'User-'+Math.floor(Math.random()*999),
  peer: null,
  conns: {}, 
  friends: JSON.parse(localStorage.getItem('p1_friends') || '{}'),
  msgs: JSON.parse(localStorage.getItem('p1_msgs') || '{"all":[]}'),
  seen: new Set(),
  isSeed: false,

  log(s) {
    const el = document.getElementById('miniLog');
    if(el) el.innerText = s + '\n' + el.innerText.slice(0, 200);
  },

  init() {
    // 生成/读取固定 ID
    if (!this.myId) {
      this.myId = 'u-' + Math.random().toString(36).substr(2, 8);
      localStorage.setItem('p1_id', this.myId);
    }
    
    this.start();
    
    // 守护进程 (3秒一次)
    setInterval(() => this.heal(), 3000);
    
    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState==='visible') this.heal();
    });
  },

  start() {
    if(this.peer && !this.peer.destroyed) return;
    try {
      const p = new Peer(this.myId, CONFIG);
      
      p.on('open', id => {
        this.myId = id;
        this.peer = p;
        this.isSeed = SEEDS.includes(id);
        this.log('✅ 上线: ' + id);
        ui.updateSelf();
        this.heal(); // 立即开始连接
      });

      p.on('connection', conn => this.setup(conn));
      
      p.on('error', err => {
        if(err.type === 'unavailable-id') setTimeout(() => this.start(), 2000);
      });
      
      this.peer = p;
    } catch(e) { this.log(e); }
  },

  // 自愈逻辑：缺谁连谁
  heal() {
    if(!this.peer || this.peer.disconnected) {
      if(this.peer) this.peer.reconnect();
      return;
    }
    
    // 连好友
    Object.keys(this.friends).forEach(pid => {
      if (!this.conns[pid] || !this.conns[pid].open) this.connect(pid);
    });
    
    // 连种子 (作为骨干)
    SEEDS.forEach(s => {
      if(s !== this.myId && (!this.conns[s] || !this.conns[s].open)) this.connect(s);
    });
  },

  connect(id) {
    if(id === this.myId) return;
    const conn = this.peer.connect(id, {reliable: true});
    this.setup(conn);
  },

  setup(conn) {
    const pid = conn.peer;
    
    conn.on('open', () => {
      this.conns[pid] = conn;
      conn.send({t: 'HELLO', n: this.myName});
      // Gossip: 交换朋友列表
      conn.send({t: 'EX', l: Object.keys(this.friends)});
      
      if(!this.friends[pid]) {
        this.friends[pid] = {name: pid.slice(0,5), unread: 0};
        this.save();
      }
      ui.renderList();
    });

    conn.on('data', d => {
      if(d.t === 'HELLO') {
        this.friends[pid].name = d.n;
        this.save();
        ui.renderList();
        if(ui.curr === pid) document.querySelector('.ch-title').innerText = d.n;
      }
      if(d.t === 'EX') {
        d.l.forEach(id => {
          if(id !== this.myId && !this.friends[id]) this.friends[id] = {name: id.slice(0,5), unread:0};
        });
        this.save();
      }
      if(d.t === 'MSG') {
        if(this.seen.has(d.id)) return;
        this.seen.add(d.id);
        
        // 路由：发给谁存谁
        const key = d.target === 'all' ? 'all' : d.src;
        if(d.target === 'all' || d.target === this.myId) {
          this.saveMsg(key, d.txt, false, d.name, d.html);
        }
        
        // 泛洪转发 (只转发群聊)
        if(d.target === 'all') this.flood(d, pid);
      }
    });

    conn.on('close', () => { delete this.conns[pid]; ui.renderList(); });
    conn.on('error', () => { delete this.conns[pid]; ui.renderList(); });
  },

  flood(pkt, exclude) {
    Object.keys(this.conns).forEach(pid => {
      if(pid !== exclude && this.conns[pid].open) {
        try { this.conns[pid].send(pkt); } catch(e){}
      }
    });
  },

  send(txt, target, isHtml) {
    const id = Date.now() + Math.random().toString();
    const pkt = {t: 'MSG', id, txt, name: this.myName, src: this.myId, target, html: isHtml};
    this.seen.add(id);
    
    const key = target === 'all' ? 'all' : target;
    this.saveMsg(key, txt, true, '我', isHtml);
    
    if(target === 'all') {
      this.flood(pkt, null);
    } else {
      const c = this.conns[target];
      if(c && c.open) c.send(pkt);
      else this.connect(target); // 尝试回拨
    }
  },

  saveMsg(key, txt, me, name, html) {
    if(!this.msgs[key]) this.msgs[key] = [];
    this.msgs[key].push({txt, me, name, html});
    if(this.msgs[key].length > 60) this.msgs[key].shift();
    localStorage.setItem('p1_msgs', JSON.stringify(this.msgs));
    
    if(ui.curr === key) ui.renderMsgs();
    else {
      if(this.friends[key]) this.friends[key].unread = (this.friends[key].unread||0) + 1;
      if(key === 'all') this.friends['all'] = {unread: (this.friends['all']?.unread||0)+1};
      this.save();
      ui.renderList();
    }
  },
  
  save() { localStorage.setItem('p1_friends', JSON.stringify(this.friends)); }
};

// ===================== UI =====================
const ui = {
  curr: 'all',

  init() {
    // DOM 元素绑定 (确保元素存在再绑)
    const bind = (id, fn) => { const el = document.getElementById(id); if(el) el.onclick = fn; }
    
    bind('btnSend', () => {
      const el = document.getElementById('editor');
      if(el.innerText.trim()) { app.send(el.innerText, this.curr); el.innerText=''; }
    });
    
    bind('btnFile', () => document.getElementById('fileInput').click());
    document.getElementById('fileInput').onchange = (e) => {
      const f = e.target.files[0];
      if(f) {
        const reader = new FileReader();
        reader.onload = ev => {
          const html = `<div class="file-card">📄 ${f.name} <a href="${ev.target.result}" download="${f.name}" class="file-btn">下载</a></div>`;
          app.send(html, this.curr, true);
        };
        reader.readAsDataURL(f);
      }
    };
    
    bind('btnBack', () => document.getElementById('sidebar').classList.remove('hidden'));
    bind('btnSet', () => document.getElementById('settings').style.display = 'grid');
    bind('btnClose', () => document.getElementById('settings').style.display = 'none');
    bind('btnSave', () => {
      const n = document.getElementById('iptNick').value;
      if(n) { app.myName = n; localStorage.setItem('p1_nick', n); ui.updateSelf(); }
      const p = document.getElementById('iptPeer').value;
      if(p) app.connect(p);
      document.getElementById('settings').style.display = 'none';
    });
    bind('btnToggleLog', () => {
      const el = document.getElementById('miniLog');
      el.style.display = el.style.display==='block'?'none':'block';
    });

    // PWA 提示
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      const btn = document.getElementById('btnInstall');
      btn.style.display = 'grid';
      btn.onclick = () => e.prompt();
    });

    this.updateSelf();
    this.switch('all');
  },

  updateSelf() {
    document.getElementById('myId').innerText = app.myId ? app.myId.slice(0,6) : '...';
    document.getElementById('myNick').innerText = app.myName;
    document.getElementById('statusText').innerText = app.isSeed ? '种子入口' : '普通节点';
    document.getElementById('statusDot').className = 'dot ' + (app.myId ? 'online':'');
  },

  renderList() {
    const list = document.getElementById('contactList');
    const allUnread = app.friends['all']?.unread || 0;
    
    let html = `
      <div class="contact-item ${this.curr==='all'?'active':''}" onclick="ui.switch('all')">
        <div class="avatar" style="background:#2a7cff">群</div>
        <div class="c-info">
          <div class="c-name">公共频道 ${allUnread?'<span class="red-dot"></span>':''}</div>
          <div class="c-status">全网广播</div>
        </div>
      </div>`;
      
    Object.keys(app.friends).forEach(pid => {
      if(pid.includes('p1-seed')) return;
      const f = app.friends[pid];
      const online = app.conns[pid] && app.conns[pid].open;
      html += `
        <div class="contact-item ${this.curr===pid?'active':''}" onclick="ui.switch('${pid}')">
          <div class="avatar" style="background:${online?'#22c55e':'#666'}">${f.name[0]}</div>
          <div class="c-info">
            <div class="c-name">${f.name} ${f.unread?'<span class="red-dot"></span>':''}</div>
            <div class="c-status" style="color:${online?'#4ade80':'#666'}">${online?'在线':'离线'}</div>
          </div>
        </div>`;
    });
    list.innerHTML = html;
  },

  switch(pid) {
    this.curr = pid;
    if(pid === 'all') {
      if(!app.friends['all']) app.friends['all'] = {};
      app.friends['all'].unread = 0;
    } else {
      if(app.friends[pid]) app.friends[pid].unread = 0;
    }
    app.save();
    
    const name = pid === 'all' ? '公共频道' : app.friends[pid].name;
    document.querySelector('.ch-title').innerText = name;
    
    if(window.innerWidth < 768) document.getElementById('sidebar').classList.add('hidden');
    this.renderList();
    this.renderMsgs();
  },

  renderMsgs() {
    const box = document.getElementById('msgList');
    box.innerHTML = '';
    const msgs = app.msgs[this.curr] || [];
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

// 启动
window.app = app;
window.ui = ui;
// 确保 DOM 加载
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ()=>app.init());
else { app.init(); setTimeout(()=>ui.init(), 100); }

})();