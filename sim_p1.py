import random
import time
from collections import deque

# --- 模拟环境参数 ---
NODE_COUNT = 50       # 模拟节点数
ROOM_TTL = 3600       # 房间号有效期
SIM_DURATION = 60     # 模拟时长(秒)
NETWORK_DELAY = 0.1   # 网络延迟(秒)

# --- 模拟类定义 ---
class Network:
    def __init__(self):
        self.nodes = {}
        self.hub_id = None
        self.msgs = []

    def get_room_id(self):
        return f"p1-room-{int(time.time() / (ROOM_TTL*1000))}" # 简化时间戳

    def broadcast(self, sender, pkt):
        # 模拟信令服务器转发/P2P转发
        for nid, node in self.nodes.items():
            if nid != sender.id:
                # 只有连上房主的或者直连的才能收到
                if node.is_connected_to(sender.id) or (sender.id == self.hub_id and node.connected_hub):
                    node.receive(pkt)

class Node:
    def __init__(self, id, net):
        self.id = id
        self.net = net
        self.is_hub = False
        self.connected_hub = False
        self.conns = set()
        self.logs = []

    def log(self, msg):
        self.logs.append(f"[{self.id}] {msg}")

    def tick(self):
        room_id = self.net.get_room_id()
        
        # 1. 核心逻辑：检查房主状态
        if self.is_hub:
            # 我是房主，保持在线
            if self.net.hub_id != self.id:
                self.log("👑 房主冲突! 自我降级")
                self.is_hub = False
        else:
            # 我不是房主
            if not self.connected_hub:
                # 尝试连接房主
                if self.net.hub_id:
                    # 模拟连接成功
                    if random.random() > 0.1: # 90%成功率
                        self.connected_hub = True
                        self.conns.add(self.net.hub_id)
                        self.log(f"✅ 连上房主 {self.net.hub_id}")
                    else:
                        self.log("❌ 连接房主失败")
                else:
                    # 没房主，尝试抢位
                    # 模拟抢位概率 (避免所有人都同时变房主)
                    if random.random() > 0.8: 
                        self.become_hub(room_id)

    def become_hub(self, room_id):
        # 模拟 PeerJS 抢占：谁先注册谁赢
        if self.net.hub_id is None:
            self.net.hub_id = self.id # 注意：在真实PeerJS里，ID是预设的
            # 但这里我们要模拟的是“谁抢到了这个名字”
            # v9.2逻辑：如果连不上p1-room，自己变成p1-room
            # 在仿真里，我们假设 self.id 变异成了 room_id
            original_id = self.id
            self.id = room_id 
            self.is_hub = True
            self.net.nodes[self.id] = self
            del self.net.nodes[original_id] # 旧身份消失
            self.log(f"🚨 上位成功! 我是 {self.id}")
        else:
            self.log("⚠️ 抢位失败，已有房主")

    def is_connected_to(self, target_id):
        return target_id in self.conns

    def receive(self, pkt):
        pass

# --- 运行模拟 ---
net = Network()
# 初始化节点
for i in range(NODE_COUNT):
    nid = f"u_{i:03d}"
    net.nodes[nid] = Node(nid, net)

print(f"--- 开始模拟 {NODE_COUNT} 个节点 ---")

# 时间步进
for t in range(SIM_DURATION):
    # 随机让房主掉线
    if net.hub_id and random.random() < 0.05:
        print(f"🔥 [时刻 {t}] 房主 {net.hub_id} 突然掉线!")
        if net.hub_id in net.nodes:
            del net.nodes[net.hub_id]
        net.hub_id = None
        # 所有人的连接断开
        for n in net.nodes.values():
            n.connected_hub = False
            n.conns.clear()

    # 节点行动
    # 这里必须用 list(values) 因为节点字典可能会变(有人改名上位)
    current_nodes = list(net.nodes.values())
    for node in current_nodes:
        node.tick()

    # 统计状态
    hubs = [n.id for n in net.nodes.values() if n.is_hub]
    orphans = [n.id for n in net.nodes.values() if not n.is_hub and not n.connected_hub]
    
    print(f"T={t:02d} | 房主: {hubs} | 孤儿: {len(orphans)} | 在线: {len(net.nodes)}")
    
    if len(hubs) > 1:
        print("❌ 严重错误：网络分裂！出现多个房主！")
        # 真实 v9.2 有合并逻辑吗？目前 v9.2 是单中心强占，
        # 实际上 peerjs-server 保证了同一个 ID 只能有一个在线。
        # 所以仿真里 hubs 永远不会大于 1 (因为 net.hub_id 是全局唯一的锁)

print("\n--- 模拟结束 ---")
print("结论推演：")
print("1. 启动阶段：会有短暂的 '无主' 状态，直到第一个幸运儿抢到 ID。")
print("2. 房主掉线：全网瞬间断连（孤儿数激增），随后几秒内会有新节点抢位成功，其他人重新连上。")
print("3. 风险点：如果信令服务器把 '抢位请求' 挂起太久，可能导致多人同时认为自己抢到了（本地 isHub=true），但在服务器端只有一个生效。")
print("   -> 修复建议：v9.2 的 setTimeout 抢位逻辑里，必须增加 '二次确认'（再次检查是否已存在连接）。")