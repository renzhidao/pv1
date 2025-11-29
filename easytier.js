(function(){
'use strict';

const CONFIG = {
  host: 'peerjs.92k.de', port: 443, secure: true, path: '/',
  config: { iceServers: [{urls:'stun:stun.l.google.com:19302'}] },
  debug: 1 // 1=Errors, 2=All. 降噪模式
};

const getRoomId = () => 'p1-room-' + Math.floor(Date.now() / 600000);

const app = {
  myId: localStorage.getItem('p1_my_id') || ('u_' + Math.random().toString(36).substr(2, 9)),
  myName: localStorage.getItem('nickname') || 'User-'+Math.floor(Math.random()*1000),
  
  peer: null,
  conns: {}, 
  contacts: JSON.parse(localStorage.getItem('p1_contacts') || '{}'),
  msgs: JSON.parse(localStorage.getItem('p1_msgs') || '{"all":[]}'),
  unread: JSON.parse(localStorage.getItem('p1_unread') || '{}'),
  seen: new Set(),
  
  isHub: false,
  roomId: getRoomId(),

  log(s) {
    const el = document.getElementById('logContent');
    if(el) {
      if(s.includes('peer-unavailable')) { console.log(s); return; } // 屏蔽刷屏
      const time = new Date().toLocaleTimeString();
      el.innerText = `[${time}] ${s}\n` + el.innerText.slice(0, 10000);
    }
    console.log(`[P1] ${s}`);
  },

  init() {
    localStorage.setItem('p1_my_id', this.myId);
    this.log(`🚀 启动 | ID: ${this.myId}`);
    
    // 修复1: 刷新前自杀，释放ID
    window.addEventListener('beforeunload', () => {
      if(this.peer) this.peer.destroy();
    });

    this.start();
    
    // 修复2: 启动即连老友
    Object.values(this.contacts).forEach(c => {
      if(c.id && c.id !== this.myId) this.connectTo(c.id);
    });
    
    setInterval(() => {
      this.cleanup();
      this.roomId = getRoomId(); 
      
      // 房主保活
      if (!this.isHub) {
        const hubConn = this.conns[this.roomId];
        if (!hubConn || !hubConn.open) this.connectTo(this.roomId);
      }
      
      // 邻居保活
      Object.values(this.contacts).forEach(c => {
        if(c.id && c.id !== this.myId && (!this.conns[c.id] || !this.conns[c.id].open)) {
           this.connectTo(c.id);
        }
      });

      this.exchange();
    }, 5000);

    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState === 'visible') this.start();
    });
  },

  start() {
    if(this.peer && !this.peer.destroyed && !this.peer.disconnected) return;
    this.initPeer(this.myId);
  },

  initPeer(id) {
    try {
      this.log(`🔌 上线中...`);
      const p = new Peer(id, CONFIG);
      
      p.on('open', myId => {
        this.myId = myId;
        this.peer = p;
        this.log(`✅ 上线成功`);
        ui.updateSelf();
        this.connectTo(this.roomId);
      });

      p.on('error', err => {
        // 修复3: 错峰抢房主
        if (err.type === 'peer-unavailable' && err.message.includes(this.roomId)) {
           if(!this.isHub) {
             const delay = 500 + Math.random() * 1500; // 随机延迟
             setTimeout(() => {
               if(!this.isHub && (!this.conns[this.roomId] || !this.conns[this.roomId].open)) {
                 this.log(`👑 尝试接管房间 (延${Math.floor(delay)}ms)`);
                 this.isHub = true;
                 this.peer.destroy();
                 setTimeout(() => this.initPeer(this.roomId), 100);
               }
             }, delay);
           }
        }
        else if (err.type === 'unavailable-id') {
           if(id === this.roomId) {
             this.log(`⚠️ 抢位失败，回退`);
             this.isHub = false;
             setTimeout(() => this.initPeer(this.myId), 500);
           }
        }
      });

      p.on('connection', conn => this.setupConn(conn));
    } catch(e) { this.log(`🔥 Fatal: ${e}`); }
  },

  connectTo(id) {
    if(!this.peer || this.peer.destroyed || id === this.myId || (this.conns[id] && this.conns[id].open)) return;
    try {
      const conn = this.peer.connect(id, {reliable: true});
      this.setupConn(conn);
    } catch(e){}
  },

  setupConn(conn) {
    conn.on('open', () => {
      this.conns[conn.peer] = conn;
      ui.renderList();
      conn.send({t: 'HELLO', n: this.myName, id: this.myId});
      this.exchange();
    });

    conn.on('data', d => {
      if(d.t === 'HELLO') {
        conn.label = d.n;
        this.contacts[d.n] = {id: d.id || conn.peer, t: Date.now()};
        localStorage.setItem('p1_contacts', JSON.stringify(this.contacts));
        ui.renderList();
        if(ui.activeChatName === d.n) ui.switchChat(d.n, conn.peer);
      }
      
      if(d.t === 'PEER_EX') {
        d.list.forEach(id => {
          if(id !== this.myId && !this.conns[id]) this.connectTo(id);
        });
      }
      
      if(d.t === 'MSG') {
        if(this.seen.has(d.id)) return;
        this.seen.add(d.id);
        this.log(`📨 消息 from ${d.senderName}`);
        
        const key = d.target === 'all' ? 'all' : d.senderName;
        const isTargetChat = (d.target === 'all' && ui.activeChatName === '公共频道') || (d.senderName === ui.activeChatName);
        
        if(d.target === 'all' || d.target === this.myName) {
          this.saveMsg(key, d.txt, false, d.senderName);
          if(!isTargetChat) {
            this.addUnread(d.target === 'all' ? '公共频道' : d.senderName);
          }
        }
        if(d.target === 'all') this.flood(d, conn.peer);
      }
    });

    conn.on('close', () => { delete this.conns[conn.peer]; ui.renderList(); });
    conn.on('error', () => { delete this.conns[conn.peer]; ui.renderList(); });
  },

  flood(pkt, exclude) {
    Object.values(this.conns).forEach(c => {
      if(c.peer !== exclude && c.open) {
        try { c.send(pkt); } catch(e){}
      }
    });
  },

  send(txt, targetName) {
    const id = Date.now() + Math.random().toString();
    const pkt = {t: 'MSG', id, txt, senderName: this.myName, target: targetName==='公共频道'?'all':targetName};
    this.seen.add(id);
    
    this.log(`📤 发送 -> ${targetName}`);
    const key = targetName === '公共频道' ? 'all' : targetName;
    this.saveMsg(key, txt, true, '我');
    
    if(targetName === '公共频道') {
      this.flood(pkt, null);
    } else {
      const cid = this.contacts[targetName]?.id;
      if(this.conns[cid] && this.conns[cid].open) this.conns[cid].send(pkt);
      else {
        this.log(`⚠️ 未直连，重连中...`);
        if(cid) this.connectTo(cid);
      }
    }
  },

  saveMsg(key, txt, me, name) {
    if(!this.msgs[key]) this.msgs[key] = [];
    const m = {txt, me, name, t: Date.now()};
    this.msgs[key].push(m);
    if(this.msgs[key].length > 50) this.msgs[key].shift();
    localStorage.setItem('p1_msgs', JSON.stringify(this.msgs));
    if(ui.activeChatName === key || (key==='all' && ui.activeChatName==='公共频道')) ui.appendMsg(m);
  },
  
  addUnread(name) {
    this.unread[name] = (this.unread[name] || 0) + 1;
    localStorage.setItem('p1_unread', JSON.stringify(this.unread));
    ui.renderList();
  },
  clearUnread(name) {
    if(this.unread[name]) {
      delete this.unread[name];
      localStorage.setItem('p1_unread', JSON.stringify(this.unread));
      ui.renderList();
    }
  },

  cleanup() {
    Object.keys(this.conns).forEach(pid => { if(!this.conns[pid].open) delete this.conns[pid]; });
  },
  
  exchange() {
    const list = Object.values(this.contacts).map(c => c.id).filter(id => id);
    const onlines = Object.keys(this.conns);
    const fullList = [...new Set([...list, ...onlines])];
    const pkt = {t: 'PEER_EX', list: fullList};
    Object.values(this.conns).forEach(c => { if(c.open) c.send(pkt); });
  }
};

const ui = {
  activeChatName: '公共频道',
  activeChatId: null,

  init() {
    const bind = (id, fn) => { const el = document.getElementById(id); if(el) el.onclick = fn; };
    
    bind('btnSend', () => {
      const el = document.getElementById('editor');
      if(el.innerText.trim()) { app.send(el.innerText.trim(), this.activeChatName); el.innerText=''; }
    });
    
    bind('btnBack', () => document.getElementById('sidebar').classList.remove('hidden'));
    
    bind('btnToggleLog', () => {
      const el = document.getElementById('miniLog');
      el.style.display = el.style.display === 'flex' ? 'none' : 'flex'; 
    });
    
    bind('btnDlLog', () => {
      const content = document.getElementById('logContent').innerText;
      const blob = new Blob([content], {type: 'text/plain'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'p1_debug_log.txt';
      a.click();
    });
    
    bind('btnSettings', () => {
       document.getElementById('settings-panel').style.display = 'grid';
       document.getElementById('iptNick').value = app.myName;
    });
    bind('btnCloseSettings', () => document.getElementById('settings-panel').style.display = 'none');
    bind('btnSave', () => {
       const n = document.getElementById('iptNick').value.trim();
       if(n) { app.myName = n; localStorage.setItem('nickname', n); ui.updateSelf(); }
       const p = document.getElementById('iptPeer').value.trim();
       if(p) app.connectTo(p);
       document.getElementById('settings-panel').style.display = 'none';
    });
    
    bind('btnFile', () => { document.getElementById('fileInput').click(); });
    document.getElementById('fileInput').onchange = function(e) {
      const f = e.target.files[0];
      if(!f) return;
      if(f.size > 5 * 1024 * 1024) { alert('文件过大，请发送 5MB 以内的文件'); this.value=''; return; }
      const r = new FileReader();
      r.onload = function(ev) {
        const data = ev.target.result;
        let msg = '';
        if(f.type.startsWith('image/')) msg = `[img]${data}[/img]`;
        else msg = `[file=${f.name}]${data}[/file]`;
        app.send(msg, ui.activeChatName);
      };
      r.readAsDataURL(f);
      this.value = '';
    };

    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      const btn = document.createElement('div');
      btn.className = 'btn-icon';
      btn.innerText = '📲';
      btn.onclick = () => { e.prompt(); btn.remove(); };
      document.querySelector('.chat-header').appendChild(btn);
    });

    this.updateSelf();
    this.switchChat('公共频道', null);
  },

  updateSelf() {
    document.getElementById('myId').innerText = app.myId ? app.myId.slice(0,6) : '...';
    document.getElementById('myNick').innerText = app.myName;
    document.getElementById('statusText').innerText = app.isHub ? '👑 值班员' : '在线';
    document.getElementById('statusDot').className = 'dot ' + (app.myId ? 'online':'');
  },

  switchChat(name, id) {
    this.activeChatName = name;
    this.activeChatId = id;
    app.clearUnread(name);
    if(id && !app.conns[id]) app.connectTo(id);
    
    document.getElementById('chatTitle').innerText = name;
    document.getElementById('chatStatus').innerText = name === '公共频道' ? '全员' : (app.conns[id]?'在线':'离线');
    
    const box = document.getElementById('msgList');
    box.innerHTML = '';
    const key = name === '公共频道' ? 'all' : name;
    (app.msgs[key]||[]).forEach(m => this.appendMsg(m));
    
    if(window.innerWidth < 768) document.getElementById('sidebar').classList.add('hidden');
    this.renderList();
  },

  renderList() {
    const list = document.getElementById('contactList');
    document.getElementById('onlineCount').innerText = Object.keys(app.conns).length;
    
    const pubUnread = app.unread['公共频道'] || 0;
    
    let html = `
      <div class="contact-item ${this.activeChatName==='公共频道'?'active':''}" onclick="ui.switchChat('公共频道', null)">
        <div class="avatar" style="background:#2a7cff">群</div>
        <div class="c-info">
          <div class="c-name">
            公共频道
            ${pubUnread > 0 ? `<span class="unread-badge">${pubUnread}</span>` : ''}
          </div>
        </div>
      </div>
    `;
    
    const names = new Set([...Object.keys(app.contacts), ...Object.values(app.conns).map(c=>c.label).filter(n=>n)]);
    names.forEach(name => {
      if(!name || name === app.myName) return;
      
      let id = app.contacts[name]?.id;
      const onlineC = Object.values(app.conns).find(c => c.label === name);
      if(onlineC) id = onlineC.peer;
      
      const isOnline = !!onlineC;
      const unread = app.unread[name] || 0;
      
      html += `
        <div class="contact-item ${this.activeChatName===name?'active':''}" onclick="ui.switchChat('${name}', '${id}')">
          <div class="avatar" style="background:${isOnline?'#22c55e':'#666'}">${name[0]}</div>
          <div class="c-info">
            <div class="c-name">
              ${name} 
              ${unread > 0 ? `<span class="unread-badge">${unread}</span>` : ''}
            </div>
            <div class="c-time">${isOnline?'在线':'离线'}</div>
          </div>
        </div>`;
    });
    list.innerHTML = html;
  },

  appendMsg(m) {
    const box = document.getElementById('msgList');
    let content = m.txt;
    content = content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    content = content.replace(/\[img\](.*?)\[\/img\]/g, '<img src="$1" class="chat-img" onclick="window.open(this.src)">');
    content = content.replace(/\[file=(.*?)\](.*?)\[\/file\]/g, '<a href="$2" download="$1" style="color:var(--text);text-decoration:underline;display:block;margin-top:5px">📄 $1</a>');
    
    box.innerHTML += `
      <div class="msg-row ${m.me?'me':'other'}">
        <div style="max-width:85%">
          <div class="msg-bubble">${content}</div>
          ${!m.me ? `<div class="msg-meta">${m.name}</div>`:''}
        </div>
      </div>`;
    box.scrollTop = box.scrollHeight;
  }
};

window.app = app;
window.ui = ui;
app.init();
setTimeout(() => ui.init(), 500);

})();