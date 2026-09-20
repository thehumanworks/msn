import { afterEach, test as nodeTest, type TestContext } from "node:test";

/** Every test gets a real deadline so a hung promise fails instead of wedging the runner. */
export const TEST_DEADLINE_MS = 20_000;

export function test(name: string, fn: (t: TestContext) => void | Promise<void>): Promise<void> {
  return nodeTest(name, { timeout: TEST_DEADLINE_MS }, fn);
}

const disposables: Array<{ dispose(): void }> = [];

/** Register a controller so it is torn down even when the test fails midway. */
export function track<T extends { dispose(): void }>(item: T): T {
  disposables.push(item);
  return item;
}

afterEach(() => {
  for (const item of disposables.splice(0)) item.dispose();
});
