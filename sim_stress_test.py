import random
import time
from collections import deque

# --- 压力测试配置 ---
NODE_COUNT = 20
SIM_DURATION = 100
ROOM_ID = "p1-room-stress"
LATENCY_MAX = 3  # 模拟最大3秒的网络延迟

class Packet:
    def __init__(self, src, dst, payload, type='MSG'):
        self.src = src
        self.dst = dst
        self.payload = payload
        self.type = type
        self.arrival_time = time.time() + random.uniform(0, LATENCY_MAX)

class SignalingServer:
    def __init__(self):
        self.owner = None
        self.lock_time = 0 # 模拟服务器注册锁

    def register(self, node):
        # 模拟网络延迟导致的竞态条件
        if self.owner is None:
            self.owner = node
            return True
        return False

    def connect(self):
        return self.owner

class Node:
    def __init__(self, id, server, network_queue):
        self.id = id
        self.real_id = id
        self.server = server
        self.net_q = network_queue
        self.is_hub = False
        self.conns = set()
        self.inbox = []
        self.pending = deque() # 离线队列

    def tick(self):
        # 状态机：没连房主就去连，连不上就抢
        hub = self.server.connect()
        
        if self.is_hub:
            if hub != self: # 发现服务器上房主不是我（脑裂）
                self.is_hub = False
                self.id = self.real_id
        else:
            if hub:
                if hub.id not in self.conns:
                    # 模拟连接握手延迟
                    self.net_q.append(Packet(self.id, hub.id, 'HELLO', 'SYS'))
                    self.conns.add(hub.id)
            else:
                # 抢房主
                if random.random() < 0.3: # 激进抢占
                    if self.server.register(self):
                        self.is_hub = True
                        self.id = ROOM_ID

    def send(self, msg):
        if self.is_hub:
            # 广播给所有连接者
            for cid in self.conns:
                self.net_q.append(Packet(self.id, cid, msg))
        elif self.conns:
            # 发给房主
            for cid in self.conns:
                self.net_q.append(Packet(self.id, cid, msg))
        else:
            self.pending.append(msg) # 存入离线队列

    def receive(self, pkt):
        if pkt.type == 'MSG':
            self.inbox.append(pkt.payload)
            if self.is_hub: # 房主转发
                for cid in self.conns:
                    if cid != pkt.src:
                        self.net_q.append(Packet(self.id, cid, pkt.payload))

# --- 运行高压测试 ---
server = SignalingServer()
net_q = deque() # 全局网络延迟队列
nodes = [Node(f"u_{i}", server, net_q) for i in range(NODE_COUNT)]

print(f"🔥 开始高压测试: {NODE_COUNT} 节点, 延迟 0-{LATENCY_MAX}s")

start_time = time.time()
msg_sent_count = 0

for t in range(SIM_DURATION):
    now = time.time()
    
    # 1. 随机事件：房主自杀 (模拟极不稳定网络)
    if server.owner and random.random() < 0.2:
        print(f"⚡ [T={t}] 房主崩溃!")
        server.owner.is_hub = False
        server.owner.id = server.owner.real_id
        server.owner = None
        # 所有连接断开
        for n in nodes: n.conns.clear()

    # 2. 节点行动
    for n in nodes: 
        n.tick()
        # 随机发消息
        if random.random() < 0.1:
            msg = f"{n.real_id}-{t}"
            n.send(msg)
            msg_sent_count += 1

    # 3. 处理网络包 (带延迟)
    # 排序模拟时间流逝
    active_pkts = []
    while net_q:
        pkt = net_q.popleft()
        if pkt.arrival_time <= now + (t * 0.1): # 加速模拟时间
            # 投递
            target = next((n for n in nodes if n.id == pkt.dst), None)
            if target: 
                target.receive(pkt)
                # 房主收到HELLO要回连
                if pkt.type == 'SYS' and target.is_hub:
                    target.conns.add(pkt.src)
        else:
            active_pkts.append(pkt)
    
    # 放回未到达的包
    for p in active_pkts: net_q.append(p)

# --- 结果统计 ---
total_received = sum(len(n.inbox) for n in nodes)
print(f"\n📊 统计结果:")
print(f"发送总数: {msg_sent_count}")
print(f"接收总数: {total_received}")
# 理想情况：每条消息会被 N-1 个人收到
ideal_received = msg_sent_count * (NODE_COUNT - 1)
loss_rate = 1 - (total_received / ideal_received) if ideal_received > 0 else 0

print(f"丢包率: {loss_rate*100:.2f}%")

if loss_rate > 0.5:
    print("❌ 失败：高延迟导致严重丢包，当前协议在弱网下不可靠！")
    print("建议：增加消息 ACK 确认机制。")
else:
    print("✅ 通过：在频繁断连和高延迟下，大部分消息仍能送达。")