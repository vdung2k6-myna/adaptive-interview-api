import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createSemaphore } from "./semaphore";

const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createSemaphore", () => {
  it("refuses a limit that admits nothing", () => {
    // A bound of zero is a guard that admits nothing, not a guard that is off;
    // reading it as "no limit" is the opposite of what it says.
    assert.throws(() => createSemaphore(0), /positive integer/);
    assert.throws(() => createSemaphore(-1), /positive integer/);
    assert.throws(() => createSemaphore(1.5), /positive integer/);
  });

  it("never has more than its limit in flight", async () => {
    const sem = createSemaphore(2);
    let active = 0;
    let peak = 0;

    const work = async () => {
      const release = await sem.acquire();
      active++;
      peak = Math.max(peak, active);
      await pause(5);
      active--;
      release();
    };

    await Promise.all(Array.from({ length: 6 }, work));

    assert.equal(peak, 2, "a third caller must wait even though the first two are only pausing");
    assert.equal(sem.inFlight(), 0, "every slot is given back");
  });

  it("admits waiters in the order they arrived", async () => {
    const sem = createSemaphore(1);
    let held = await sem.acquire();

    const admitted: number[] = [];
    const waiters = [0, 1, 2].map((index) =>
      sem.acquire().then((release) => {
        admitted.push(index);
        return release;
      })
    );

    for (let index = 0; index < waiters.length; index++) {
      held();
      held = await waiters[index];
      assert.deepEqual(
        admitted,
        [0, 1, 2].slice(0, index + 1),
        "each release admits the next caller, never a later one"
      );
    }
    held();
    assert.equal(sem.inFlight(), 0);
  });

  it("hands a freed slot to the waiter rather than to a caller arriving after the release", async () => {
    const sem = createSemaphore(1);
    const held = await sem.acquire();

    const admitted: string[] = [];
    const waiting = sem.acquire().then((release) => {
      admitted.push("waiting");
      return release;
    });

    // The release hands the slot over directly, so the count stays at the limit
    // and a caller arriving now has to queue behind the one already waiting.
    held();
    assert.equal(sem.inFlight(), 1);

    const late = sem.acquire();
    assert.equal(sem.waiting(), 1);

    const releaseWaiting = await waiting;
    assert.deepEqual(admitted, ["waiting"]);

    releaseWaiting();
    const releaseLate = await late;
    assert.equal(sem.inFlight(), 1);
    releaseLate();
    assert.equal(sem.inFlight(), 0);
  });

  it("lets a caller that gives up leave the queue", async () => {
    const sem = createSemaphore(1);
    const held = await sem.acquire();

    const controller = new AbortController();
    const queued = sem.acquire(controller.signal);
    assert.equal(sem.waiting(), 1);

    controller.abort();
    await assert.rejects(queued, /aborted/i);
    assert.equal(sem.waiting(), 0, "an abandoned waiter is not left holding a place");

    held();
    assert.equal(sem.inFlight(), 0, "and releasing does not grant a slot to it");

    const next = await sem.acquire();
    assert.equal(sem.inFlight(), 1);
    next();
  });

  it("refuses an acquire whose signal has already aborted", async () => {
    const sem = createSemaphore(1);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(sem.acquire(controller.signal), /aborted/i);
    assert.equal(sem.inFlight(), 0);
  });

  it("does not release a slot twice", async () => {
    const sem = createSemaphore(1);
    const release = await sem.acquire();

    release();
    release();

    assert.equal(sem.inFlight(), 0, "a second release cannot free a slot nobody holds");
    const next = await sem.acquire();
    assert.equal(sem.inFlight(), 1);
    next();
  });
});
