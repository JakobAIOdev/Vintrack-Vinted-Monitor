## 2024-05-24 - [React SSE Feed Rendering Bottleneck]
**Learning:** Appending items to an array in React state from an SSE stream forces all previously rendered items to re-render, creating an O(N) rendering bottleneck. The list gets sluggish as it grows, making the app feel slow and unresponsive.
**Action:** When building live lists (like feed streams or chat apps), always wrap individual list item components in `React.memo` so that only the newly inserted items trigger a render.
