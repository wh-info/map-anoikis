// In-memory ring buffer for the most recent N kills. When a new client
// connects we replay the whole thing as a single "snapshot" message so the
// map doesn't look empty on first load. Losing the buffer on worker restart
// is fine — R2Z2 will keep streaming and it refills within minutes.

export function createRing(capacity) {
  const items = [];
  return {
    push(item) {
      items.push(item);
      if (items.length > capacity) items.shift();
    },
    snapshot() {
      return items.slice();
    },
    get size() {
      return items.length;
    }
  };
}
