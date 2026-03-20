
## 2024-03-24 - [React.memo for SSE list bottlenecks]
**Learning:** Real-time lists receiving frequent SSE updates (like `LiveFeed`) cause React to re-render every item component on every update. As the list grows, this creates an O(N) rendering bottleneck causing significant CPU spikes and browser jank.
**Action:** Always wrap individual list item components in `React.memo` when rendering live lists that receive real-time updates via SSE or WebSockets to ensure O(1) performance per update.
