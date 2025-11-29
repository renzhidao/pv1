import random
import time

# --- 模拟参数 ---
NODE_COUNT = 50
SIM_DURATION = 50
ROOM_ID = "p1-room-fixed"

# --- 模拟信令服务器 (上帝视角) ---
class SignalingServer:
    def __init__(self):
        self.registered_peers = {} # ID -> Node
        self.room_owner = None     # 谁占用了 p1-room-fixed

    def register(self, node, requested_id):
        # 模拟抢占逻辑
        if requested_id == ROOM_ID:
            if self.room_owner is None:
                self.room_owner = node
                return True
            else:
                return False # 已经被占了
        self.registered_peers[requested_id] = node
        return True

    def connect(self, source_node, target_id):
        # 模拟建立连接
        target = None
        if target_id == ROOM_ID:
            target = self.room_owner
        else:
            target = self.registered_peers.get(target_id)
        
        if target:
            # 握手成功，建立双向虚拟连接
            source_node.conns[target_id] = target
            target.conns[source_node.id] = source_node
            return True
        return False

# --- 节点逻辑 (完全复刻 v9.2 JS 逻辑) ---
class Node:
    def __init__(self, id, server):
        self.real_id = id # 真实的唯一ID
        self.id = id      # 当前使用的ID (可能是 real_id 也可能是 ROOM_ID)
        self.server = server
        self.conns = {}   # 虚拟连接池
        self.is_hub = False
        self.retry_timer = 0
        self.inbox = []   # 收件箱

    def log(self, text):
        # 只打印关键角色的日志，避免刷屏
        if self.real_id in ['u_000', 'u_001']: 
            print(f"[{self.id}] {text}")

    def tick(self, now):
        # 1. 检查连接状态
        hub_conn_alive = ROOM_ID in self.conns or self.is_hub
        
        # 2. 掉线/未连接处理 (Retry Pending)
        if not hub_conn_alive:
            if now > self.retry_timer:
                self.retry_timer = now + 2 # 2秒重试一次
                self.attempt_connect()

    def attempt_connect(self):
        # 尝试连房主
        if self.server.connect(self, ROOM_ID):
            self.log("✅ 连上房主了")
        else:
            # 连不上，尝试上位 (v9.2 核心)
            if self.server.register(self, ROOM_ID):
                self.log("🚨 抢位成功! 我变身房主")
                self.is_hub = True
                self.id = ROOM_ID # 身份变更
            else:
                # 抢位失败（说明有人占了，或者并发冲突），保持原样
                pass

    def send_msg(self, target_real_id, text):
        # 发送逻辑：A -> Hub -> B
        # 1. 找到房主连接
        hub = self.conns.get(ROOM_ID)
        
        if self.is_hub:
            # 我就是房主，直接转发
            self.hub_forward(self.real_id, target_real_id, text)
            return True
            
        if hub:
            # 发给房主请求转发
            hub.hub_forward(self.real_id, target_real_id, text)
            return True
        
        return False # 发送失败（没网）

    def hub_forward(self, sender_id, target_id, text):
        # 房主转发逻辑
        # 在仿真里，房主的 conns 存的是所有连接它的节点
        # 需要遍历找到 real_id 匹配的目标 (因为 conns key 是 socket id)
        
        # 简化：直接广播给所有人 (Gossip 逻辑)
        for peer in self.conns.values():
            if peer.real_id != sender_id:
                peer.receive(text, sender_id)
        
        # 如果我自己就是目标
        if self.real_id == target_id:
            self.receive(text, sender_id)

    def receive(self, text, sender):
        self.inbox.append(f"From {sender}: {text}")

# --- 运行模拟 ---
server = SignalingServer()
nodes = []

# 1. 创建 50 个节点
for i in range(NODE_COUNT):
    n = Node(f"u_{i:03d}", server)
    nodes.append(n)
    server.register(n, n.id)

print(f"--- 阶段1: {NODE_COUNT} 人上线混战 ---")
for t in range(10):
    for n in nodes: n.tick(t)

# 检查谁是房主
owner = server.room_owner
print(f"T=10 | 当前房主: {owner.real_id if owner else '无'} | 房主连接数: {len(owner.conns) if owner else 0}")

# 测试通信
if nodes[1].send_msg("u_000", "Hello"):
    print("📨 u_001 发送消息给 u_000: 成功提交")
else:
    print("📨 u_001 发送消息给 u_000: 失败 (无连接)")

time.sleep(0.5) # 等待转发
print(f"📬 u_000 收件箱: {nodes[0].inbox}")

print("\n--- 阶段2: 灭霸响指 (只留 u_000 和 u_001，且把现任房主杀掉) ---")
# 强制杀掉房主 (模拟崩溃)
if server.room_owner:
    print(f"💀 处决房主: {server.room_owner.real_id}")
    server.room_owner = None # 服务器端释放占用

# 移除除了 0 和 1 以外的所有人
survivors = [nodes[0], nodes[1]]
nodes = survivors
# 清空他们的连接池 (模拟断网)
for n in nodes: 
    n.conns = {} 
    n.is_hub = False
    n.id = n.real_id # 身份重置

print(f"T=20 | 幸存者: {len(nodes)} 人 | 此时网络状态: 完全断开")

# 模拟自愈过程
for t in range(20, 40):
    # 打印状态
    if t % 2 == 0:
        hubs = [n.real_id for n in nodes if n.is_hub]
        print(f"T={t} | 幸存者正在自愈... 房主: {hubs}")
        
    for n in nodes: n.tick(t)
    
    # 只要通了就尝试发消息
    if t == 30:
        print("Try chatting...")
        nodes[0].send_msg("u_001", "Are you there?")

print(f"\n--- 最终检查 ---")
print(f"u_001 收件箱: {nodes[1].inbox}")

if len(nodes[1].inbox) > 0:
    print("✅ 测试通过：幸存的 2 人成功选出了新房主并恢复了通信！")
else:
    print("❌ 测试失败：幸存者未能恢复通信。")
    print("原因分析：可能两人同时抢位互斥，或者重连间隔太长。")