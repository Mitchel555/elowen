/** A ROUND-ROBIN QUEUE ACROSS INDEPENDENT PRODUCERS.
 *
 *  A workflow's `tick()` launches every ready node in ONE event-loop turn, so a 30-node DAG can put 30
 *  turns into the admission queue before an unrelated single delegation gets a look in. Plain FIFO would
 *  make that unrelated delegation wait for the whole DAG — which is starvation, not scheduling.
 *
 *  So items are filed into a LANE per producer (the delegating parent session: one workflow, one lane) and
 *  drained one lane at a time in rotation. Within a lane the order is FIFO, which preserves the arrival
 *  order of a workflow's own nodes. The result: N producers each get ~1/N of the placements regardless of
 *  how many items each of them pushed. */
export class FairQueue<T> {
  private readonly lanes = new Map<string, T[]>();
  /** Lane keys in service order; the head is served next and rotates to the back. Kept beside the map
   *  because Map iteration order is INSERTION order, which is not the rotation this needs. */
  private order: string[] = [];
  private count = 0;

  get depth(): number { return this.count; }

  push(key: string, item: T): void {
    const lane = this.lanes.get(key);
    if (lane) {
      lane.push(item);
    } else {
      this.lanes.set(key, [item]);
      this.order.push(key);
    }
    this.count += 1;
  }

  /** Next item in rotation, or undefined when empty. */
  shift(): T | undefined {
    while (this.order.length > 0) {
      const key = this.order[0] as string;
      const lane = this.lanes.get(key);
      if (!lane || lane.length === 0) {
        this.order.shift();
        this.lanes.delete(key);
        continue;
      }
      const item = lane.shift() as T;
      this.count -= 1;
      // Rotate: this lane goes to the BACK whether or not it still has work, so the next placement goes
      // to a different producer. A lane that emptied is dropped entirely.
      this.order.shift();
      if (lane.length > 0) this.order.push(key);
      else this.lanes.delete(key);
      return item;
    }
    return undefined;
  }

  /** Put an item BACK where it was: head of its own lane, and that lane next in the rotation. Used when a
   *  shifted item turns out not to be placeable — plain `push` would send its producer to the back of the
   *  rotation for having been offered a slot it could not take, which is the opposite of fair. */
  unshift(key: string, item: T): void {
    const lane = this.lanes.get(key);
    if (lane) lane.unshift(item);
    else this.lanes.set(key, [item]);
    const at = this.order.indexOf(key);
    if (at >= 0) this.order.splice(at, 1);
    this.order.unshift(key);
    this.count += 1;
  }

  /** Everything still queued, WITHOUT touching the rotation. `/health` reads the queue on every scrape,
   *  and a reporting call that drained and re-pushed would silently reorder who gets served next. */
  *entries(): IterableIterator<T> {
    for (const lane of this.lanes.values()) yield* lane;
  }

  /** Everything still queued, for teardown. Leaves the queue empty. */
  drain(): T[] {
    const all: T[] = [];
    for (;;) {
      const next = this.shift();
      if (next === undefined) break;
      all.push(next);
    }
    return all;
  }
}
