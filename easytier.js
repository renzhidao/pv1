(function(){
'use strict';

// ===================== 全网全通配置 =====================
const CONFIG = {
  host: 'peerjs.92k.de', port: 443, secure: true, path: '/',
  config: { iceServers: [{urls:'stun:stun.l.google.com:19302'}] },
  debug: 0
};

// 🔥 扩容：允许每台设备最多维持 50 个连接
const MAX_NEIGHBORS = 50; 
// 3 个固定入口，保证无论何时都有门能进
const SEEDS = ['p1-s1', 'p1-s2', 'p1-s3']; 

// ===================== 核心逻辑 =====================
const app = {
  myId: '',
  myName: localStorage.getItem('nickname') || 'User-'+Math.floor(Math.random()*10000),
  peer: null,
  conns: {}, // 活跃连接
  knownPeers: new Set(), // 通讯录
  seenMsgs: new Set(),   // 消息去重
  
  isSeed: false,

  log(s) {
    const el = document.getElementById('miniLog');
    if(el) el.innerText = `[${new Date().toLocaleTimeString()}] ${s}\n` + el.innerText.slice(0, 300);
  },

  init() {
    this.start();
    
    // 🕸️ 5秒一次：清理死链、交换通讯录、尝试上位
    setInterval(() => {
      this.cleanup();
      this.exchangePeers();
      this.checkNetworkHealth();
    }, 5000);
    
    // 1分钟一次：清理消息指纹
    setInterval(() => this.seenMsgs.clear(), 60000);
  },

  start() {
    if(this.peer) return;
    
    // 启动时，先随机尝试抢一个种子位，抢不到就做普通人
    // 这样能让多台设备自动分散承担“入口”责任
    const randIndex = Math.floor(Math.random() * SEEDS.length);
    
    // 尝试以种子身份启动
    this.initPeer(SEEDS[randIndex], true); 
  },

  initPeer(id, trySeed = false) {
    try {
      // 如果 trySeed 为 false，则 id 为 undefined (自动随机)
      const p = new Peer(trySeed ? id : undefined, CONFIG);
      
      p.on('open', myId => {
        this.myId = myId;
        this.peer = p;
        this.isSeed = SEEDS.includes(myId);
        
        this.log(`✅ 就绪: ${myId.slice(0,6)} ${this.isSeed ? '(入口)' : ''}`);
        ui.updateSelf();
        
        // 🔥 关键：无论我是谁，我都去连那 3 个固定入口
        // 这样种子之间会互连，普通人也会连种子，瞬间结网
        SEEDS.forEach(s => { 
          if(s !== myId) this.connectTo(s); 
        });
      });

      p.on('error', err => {
        if(err.type === 'unavailable-id') {
          // 哎呀，这个种子位被人占了
          if (trySeed) {
            // 那我就做普通人吧 (递归调用，id=undefined)
            this.log('入口已满，以普通节点加入...');
            this.initPeer(undefined, false);
          }
        } else {
          // this.log(`Err: ${err.type}`);
        }
      });

      p.on('connection', conn => this.handleConn(conn, true));
    } catch(e) {
      this.log('启动异常: ' + e);
    }
  },

  // 主动去连别人
  connectTo(targetId) {
    if(targetId === this.myId || this.conns[targetId]) return;
    if(Object.keys(this.conns).length >= MAX_NEIGHBORS) return;
    
    const conn = this.peer.connect(targetId, {reliable: true});
    this.handleConn(conn, false);
  },

  // 处理连接（无论是别人连我，还是我连别人）
  handleConn(conn, isIncoming) {
    const pid = conn.peer;
    
    conn.on('open', () => {
      this.conns[pid] = conn;
      this.knownPeers.add(pid);
      ui.renderList();
      
      // 1. 握手：报名字
      conn.send({t: 'HELLO', n: this.myName});
      
      // 2. 互换资源：把我认识的所有人告诉你
      const list = [...this.knownPeers, ...Object.keys(this.conns)];
      conn.send({t: 'PEER_EX', list: list});
    });

    conn.on('data', d => {
      // 更新名字
      if(d.t === 'HELLO') {
        conn.label = d.n;
        ui.renderList();
      }
      
      // 收到通讯录 -> 尝试扩展连接
      if(d.t === 'PEER_EX' && Array.isArray(d.list)) {
        d.list.forEach(id => {
          this.knownPeers.add(id);
          // 如果我连接数还很少，就去连这些新朋友
          if (Object.keys(this.conns).length < 10 && id !== this.myId) {
            this.connectTo(id);
          }
        });
      }
      
      // 收到消息 -> 显示 + 转发
      if(d.t === 'MSG') {
        if(this.seenMsgs.has(d.id)) return; // 重复消息，扔掉
        this.seenMsgs.add(d.id);
        
        ui.appendMsg(d.sender, d.txt, false);
        this.flood(d, pid); // 传给其他人
      }
    });

    conn.on('close', () => this.dropPeer(pid));
    conn.on('error', () => this.dropPeer(pid));
  },

  dropPeer(pid) {
    delete this.conns[pid];
    ui.renderList();
  },

  // 泛洪转发：像病毒一样扩散消息
  flood(packet, excludeId) {
    Object.keys(this.conns).forEach(pid => {
      if(pid !== excludeId && this.conns[pid].open) {
        try { this.conns[pid].send(packet); } catch(e){}
      }
    });
  },

  sendText(txt) {
    const id = Date.now() + Math.random().toString(36);
    const packet = {t: 'MSG', id, txt, sender: this.myName};
    this.seenMsgs.add(id);
    
    ui.appendMsg('我', txt, true);
    this.flood(packet, null); // 发给所有人
  },

  // === 维护 ===
  cleanup() {
    Object.keys(this.conns).forEach(pid => {
      if(!this.conns[pid].open) this.dropPeer(pid);
    });
  },

  exchangePeers() {
    // 定期把新认识的人告诉邻居
    const list = [...Object.keys(this.conns)].slice(0, 20);
    const packet = {t: 'PEER_EX', list: list};
    Object.values(this.conns).forEach(c => {
      if(c.open) c.send(packet);
    });
  },
  
  checkNetworkHealth() {
    // 保底机制：如果我一个连接都没有，说明我掉队了
    // 尝试重新做人（重新初始化）
    if (Object.keys(this.conns).length === 0 && !this.isSeed) {
       // 重新尝试连接种子
       SEEDS.forEach(s => this.connectTo(s));
    }
  }
};

// ===================== UI =====================
const ui = {
  init() {
    document.getElementById('btnSend').onclick = () => {
      const el = document.getElementById('editor');
      if(el.innerText.trim()) {
        app.sendText(el.innerText.trim());
        el.innerText = '';
      }
    };
    document.getElementById('btnBack').onclick = () => {
      document.getElementById('sidebar').classList.remove('hidden');
    };
    
    this.updateSelf();
    this.renderList();
  },

  updateSelf() {
    document.getElementById('myId').innerText = app.myId ? app.myId.slice(0,6) : '...';
    const role = app.isSeed ? '👑 网络入口' : '✅ 互联节点';
    document.getElementById('statusText').innerText = role;
    document.getElementById('statusDot').className = 'dot ' + (app.myId ? 'online':'');
  },

  renderList() {
    const list = document.getElementById('contactList');
    const count = Object.keys(app.conns).length;
    document.getElementById('onlineCount').innerText = count + ' 连接';

    list.innerHTML = `
      <div class="contact-item active" onclick="ui.toggleSidebar()">
        <div class="avatar" style="background:#2a7cff">群</div>
        <div class="c-info">
          <div class="c-name">公共频道</div>
          <div class="c-msg">已与 ${count} 个设备互联</div>
        </div>
      </div>
    `;
    
    Object.keys(app.conns).forEach(pid => {
      const c = app.conns[pid];
      list.innerHTML += `
        <div class="contact-item">
          <div class="avatar" style="background:#333">${(c.label||pid)[0]}</div>
          <div class="c-info">
            <div class="c-name">${c.label || pid.slice(0,6)}</div>
            <div class="c-msg">${pid.includes('p1-s') ? '引导节点' : '直连'}</div>
          </div>
        </div>
      `;
    });
  },

  appendMsg(name, txt, isMe) {
    const box = document.getElementById('msgList');
    const d = document.createElement('div');
    d.className = `msg-row ${isMe?'me':'other'}`;
    d.innerHTML = `
      <div style="max-width:85%">
        <div class="msg-bubble">${txt}</div>
        ${!isMe ? `<div class="msg-meta">${name}</div>` : ''}
      </div>`;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  },
  
  toggleSidebar() {
    if(window.innerWidth < 768) document.getElementById('sidebar').classList.add('hidden');
  }
};

// 启动
window.app = app;
window.ui = ui;
ui.init();
app.init();

})();