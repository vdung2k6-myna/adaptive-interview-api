/**
 * A bound on how much work this process has in flight at once.
 *
 * Two limits need the same body: how many model requests may be open across the
 * process (`config.ollama.maxConcurrentRequests`) and how many syntheses one turn
 * may have running (`config.audio.synthesisConcurrency`). Both sit in front of a
 * service that serves one request at a time, so the bound decides who waits — it
 * cannot make anything faster.
 *
 * FIFO, and that is the contract rather than an implementation detail: a queue
 * that admits out of order lets a turn that just arrived jump ahead of one that
 * has been waiting since before it. The release hands its slot directly to the
 * next waiter instead of decrementing the count and letting a newcomer race for
 * it, which is what makes the order hold.
 */

/** Give back a slot taken by `acquire`. Calling it twice is harmless. */
export type ReleaseSlot = () => void;

export interface Semaphore {
  /**
   * Wait for a slot, in arrival order.
   *
   * With a signal, a caller that gives up while queued leaves the queue instead
   * of being handed a slot nobody is left to use — which is what makes a
   * disconnected turn free its place rather than holding work open behind it.
   */
  acquire(signal?: AbortSignal): Promise<ReleaseSlot>;
  /** Slots currently held. */
  inFlight(): number;
  /** Callers waiting for a slot. */
  waiting(): number;
}

interface Waiter {
  resolve: (release: ReleaseSlot) => void;
  reject: (err: Error) => void;
  /** Removes this waiter's abort listener once it is admitted. */
  detach: () => void;
}

function abortError(): Error {
  const err = new Error("The semaphore wait was aborted.");
  err.name = "AbortError";
  return err;
}

export function createSemaphore(limit: number): Semaphore {
  if (!Number.isInteger(limit) || limit < 1) {
    // A bound of zero is not "no bound" — it is a guard that admits nothing, and
    // silently treating it as one would stop every turn rather than report a
    // misconfiguration.
    throw new Error(`a semaphore needs a positive integer limit, got ${String(limit)}`);
  }

  let inFlight = 0;
  const queue: Waiter[] = [];

  /** The release handed to whoever holds a slot. */
  const grant = (): ReleaseSlot => {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      const next = queue.shift();
      if (next) {
        // Hand the slot over rather than opening it: `inFlight` does not change,
        // and a caller that arrives after this release cannot take the slot from
        // the caller already waiting for it.
        next.detach();
        next.resolve(grant());
        return;
      }

      inFlight--;
    };
  };

  return {
    acquire(signal?: AbortSignal) {
      if (signal?.aborted) return Promise.reject(abortError());

      if (inFlight < limit) {
        inFlight++;
        return Promise.resolve(grant());
      }

      return new Promise<ReleaseSlot>((resolve, reject) => {
        const waiter: Waiter = {
          resolve,
          reject,
          detach: () => {
            if (signal) signal.removeEventListener("abort", onAbort);
          },
        };

        const onAbort = () => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          waiter.detach();
          reject(abortError());
        };

        if (signal) signal.addEventListener("abort", onAbort, { once: true });
        queue.push(waiter);
      });
    },

    inFlight: () => inFlight,
    waiting: () => queue.length,
  };
}
