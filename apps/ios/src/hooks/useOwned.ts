import { useEffect, useState } from "react";

/**
 * Creates a disposable object in an effect (never during render) and disposes it on cleanup or
 * when `deps` change. Returns null until it exists, so React StrictMode's mount/unmount/mount
 * cycle can never leave a disposed controller in use.
 */
export function useOwned<T>(create: () => T, dispose: (value: T) => void, deps: readonly unknown[]): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    const created = create();
    setValue(created);
    return () => {
      setValue(null);
      dispose(created);
    };
  }, deps);
  return value;
}
