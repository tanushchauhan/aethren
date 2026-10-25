/** Tiny LRU keyed by string, bounded by entry count and total byte length. */
export function createLru<V extends { length: number }>(maxEntries: number, maxBytes: number) {
  const map = new Map<string, V>();
  let bytes = 0;
  return {
    get(key: string): V | undefined {
      const v = map.get(key);
      if (v !== undefined) {
        map.delete(key);
        map.set(key, v);
      }
      return v;
    },
    set(key: string, value: V): void {
      const old = map.get(key);
      if (old) {
        bytes -= old.length;
        map.delete(key);
      }
      map.set(key, value);
      bytes += value.length;
      while (map.size > maxEntries || bytes > maxBytes) {
        const oldest = map.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        bytes -= map.get(oldest)!.length;
        map.delete(oldest);
      }
    },
    get size() {
      return map.size;
    },
  };
}
