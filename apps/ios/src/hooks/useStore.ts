import { useSyncExternalStore } from "react";
import type { Store } from "../core/store.ts";

/** Subscribe to a core Store. Its snapshots are immutable, so identity comparison is exact. */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
