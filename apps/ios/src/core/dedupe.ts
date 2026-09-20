/**
 * Bounded id cache used to deduplicate messages/events across catchup pages, long-poll pages,
 * and replayed retries. Insertion order is preserved (a Map iterates in insertion order), so the
 * oldest ids are evicted first once `capacity` is exceeded — this is the "bounded caches" the
 * contract asks for: memory never grows without limit, and there is no silent unbounded queue.
 */
export class BoundedIdSet {
  private readonly seen = new Map<number, true>();
  private readonly capacity: number;

  constructor(capacity: number) {
    if (capacity < 1) throw new RangeError("capacity must be at least 1");
    this.capacity = capacity;
  }

  has(id: number): boolean {
    return this.seen.has(id);
  }

  /** Returns true if this id was newly added (i.e. it was not a duplicate). */
  add(id: number): boolean {
    if (this.seen.has(id)) return false;
    this.seen.set(id, true);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}
