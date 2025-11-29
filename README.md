# p1
Last Updated: Fri Nov 28 11:45:00 UTC 2025

> **Major Architecture Overhaul**:
> - **Protocol**: Switched to **Gossip Protocol** for unlimited scalability (10k+ users theoretical).
> - **Storage**: Added **IndexedDB** for persistent chat history.
> - **Sync**: Implemented **Offline Queue** (auto-retry) and **History Sync** (pull missing messages from neighbors).
> - **Network**: Using sparse mesh (max 8 peers) to prevent browser collapse.