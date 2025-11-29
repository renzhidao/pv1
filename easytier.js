(function(){
'use strict';

// ===================== 逃生通道配置 =====================
const CONFIG = {
  host: 'peerjs.92k.de', port: 443, secure: true, path: '/',
  config: { iceServers: [{urls:'stun:stun.l.google.com:19302'}] },
  debug: 0
};

const getRoomId = () => 'p1-room-' + Math.floor(Date.now() / 600000);

const app = {
  myId: '',
  myName: localStorage.getItem('nickname') || 'User-'+Math.floor(Math.random()*1000),
  peer: null,
  conns: {}, 
  contacts: JSON.parse(localStorage.getItem('p1_contacts') || '{}'),
  msgs: JSON.parse(localStorage.getItem('p1_msgs') || '{"all":[]}'),
  // 需求：红点数据存储
  unread: JSON.parse(localStorage.getItem('p1_unread') || '{}'),
  seen: new Set(),
  
  isHub: false,

  log(s) {
    const el = document.getElementById('miniLog');
    if(el) el.innerText = `[${new Date().toLocaleTimeString()}] ${s}\n` + el.innerText.slice(0, 200);
  },

  init() {
    this.start();
    setInterval(() => {
      this.cleanup();
      this.exchange();
      if(Object.keys(this.conns).length === 0 && !this.isHub) this.start();
    }, 5000);
    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState === 'visible' && (!this.peer || this.peer.disconnected)) this.start();
    });
  },

  start() {
    if(this.peer && !this.peer.destroyed) return;
    const roomId = getRoomId();
    this.initPeer(undefined, roomId);
  },

  initPeer(id, roomId) {
    try {
      const p = new Peer(id, CONFIG);
      p.on('open', myId => {
        this.myId = myId;
        this.peer = p;
        this.isHub = (myId === roomId);
        ui.updateSelf();
        this.log(`✅ 上线: ${this.myName}`);
        if (!this.isHub) {
          this.connectTo(roomId);
          Object.values(this.contacts).forEach(c => { if(c.id) this.connectTo(c.id); });
        } else {
          this.log('👑 我是本时段的值班员');
        }
      });

      p.on('error', err => {
        if (err.type === 'peer-unavailable' && err.message.includes(roomId)) {
           this.log('🚨 房间空闲，正在上位...');
           this.peer.destroy();
           this.peer = null;
           setTimeout(() => this.initPeer(roomId, null), 500);
        }
        else if (err.type === 'unavailable-id') {
           if(id === roomId) {
             this.log('👑 席位已满，转普通节点');
             this.initPeer(undefined, roomId);
           }
        }
      });

      p.on('connection', conn => this.setupConn(conn));
    } catch(e) { this.log('Fatal: '+e); }
  },

  connectTo(id) {
    if(id === this.myId || this.conns[id]) return;
    const conn = this.peer.connect(id, {reliable: true});
    this.setupConn(conn);
  },

  setupConn(conn) {
    const pid = conn.peer;
    conn.on('open', () => {
      this.conns[pid] = conn;
      ui.renderList();
      conn.send({t: 'HELLO', n: this.myName});
      const list = Object.values(this.contacts).map(c => c.id).filter(id => id);
      conn.send({t: 'PEER_EX', list});
    });

    conn.on('data', d => {
      if(d.t === 'HELLO') {
        conn.label = d.n;
        this.contacts[d.n] = {id: pid, t: Date.now()};
        localStorage.setItem('p1_contacts', JSON.stringify(this.contacts));
        ui.renderList();
        if(ui.activeChatName === d.n) ui.switchChat(d.n, pid);
      }
      
      if(d.t === 'PEER_EX') {
        d.list.forEach(id => {
          if(id !== this.myId && !this.conns[id] && Object.keys(this.conns).length < 8) this.connectTo(id);
        });
      }
      
      if(d.t === 'MSG') {
        if(this.seen.has(d.id)) return;
        this.seen.add(d.id);
        
        const key = d.target === 'all' ? 'all' : d.senderName;
        if(d.target === 'all' || d.target === this.myName) {
          this.saveMsg(key, d.txt, false, d.senderName);
          
          // 需求：红点逻辑
          if(d.target !== 'all' && ui.activeChatName !== d.senderName) {
            this.addUnread(d.senderName);
          }
        }
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

  send(txt, targetName) {
    const id = Date.now() + Math.random().toString();
    const pkt = {t: 'MSG', id, txt, senderName: this.myName, target: targetName==='公共频道'?'all':targetName};
    this.seen.add(id);
    
    const key = targetName === '公共频道' ? 'all' : targetName;
    this.saveMsg(key, txt, true, '我');
    
    if(targetName === '公共频道') {
      this.flood(pkt, null);
    } else {
      const cid = this.contacts[targetName]?.id;
      if(this.conns[cid]) this.conns[cid].send(pkt);
      else {
        if(cid) this.connectTo(cid);
        setTimeout(() => { if(this.conns[cid]) this.conns[cid].send(pkt); }, 2000);
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
  
  // 需求：红点管理
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
    const pkt = {t: 'PEER_EX', list};
    Object.values(this.conns).forEach(c => { if(c.open) c.send(pkt); });
  }
};

// ===================== UI =====================
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
    
    // 设置
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
    
    // 需求：附件功能
    bind('btnFile', () => { document.getElementById('fileInput').click(); });
    document.getElementById('fileInput').onchange = function(e) {
      const f = e.target.files[0];
      if(!f) return;
      
      // 简单大小限制，避免Base64卡顿
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

    // PWA
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      const btn = document.createElement('div');
      btn.className = 'btn-icon';
      btn.innerText = '';
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
    
    // 需求：清除红点
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
    
    let html = `
      <div class="contact-item ${this.activeChatName==='公共频道'?'active':''}" onclick="ui.switchChat('公共频道', null)">
        <div class="avatar" style="background:#2a7cff">群</div>
        <div class="c-info"><div class="c-name">公共频道</div></div>
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
      
      // 需求：显示红点数字
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
    
    // 需求：解析图片和文件
    let content = m.txt;
    // 简单XSS防护+解析
    content = content.replace(/</g, '<').replace(/>/g, '>');
    // 还原解析逻辑
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