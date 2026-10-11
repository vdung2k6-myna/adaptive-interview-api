/**
 * The turns that are waiting to be told what a gadget did.
 *
 * A turn asks the model with the gadget's own catalogue, and the model may answer with a call
 * instead of words. The bridge is the only thing that can make that call — the gadget's tool
 * channel lives inside its own socket — so the turn stops, tells the bridge what was asked
 * for, and waits here for what came back. That wait is the whole of what this file is.
 *
 * A hold is single-use and keyed by an id the turn invents, so a result that arrives twice, or
 * for a turn that has already given up, is reported rather than acted on.
 */

export type ToolCallOutcome =
  /** The gadget did it. `text` is its own report of what it did, as the model should hear
   *  it — which may be a refusal rather than a failure, and is the model's to read. */
  | { ok: true; text: string }
  /** It did not, and `message` is what went wrong, in words the model can act on. */
  | { ok: false; message: string };

export interface ToolCallStore {
  /**
   * Hold a wait for `turnId`, for at most `timeoutMs`.
   *
   * Opened *before* the event carrying the id is sent, so a bridge that reports back at once
   * is not writing to a hold that does not exist yet — the ordering the whole exchange rests
   * on, and the reason this is not a bare map of promises.
   *
   * The wait times out into an outcome rather than rejecting: a call that was not reported on
   * is a thing the turn has to say something about, not an exception to unwind.
   */
  open(turnId: string, timeoutMs: number): Promise<ToolCallOutcome>;

  /** Settle a wait with what the bridge reported. Returns whether one was open — a result for
   *  a turn that has already timed out is a line in the log, not a crash. */
  settle(turnId: string, outcome: ToolCallOutcome): boolean;

  /** Holds currently open. For tests and diagnostics. */
  size(): number;
}

export function createToolCallStore(): ToolCallStore {
  const waiting = new Map<string, (outcome: ToolCallOutcome) => void>();

  return {
    open(turnId, timeoutMs) {
      return new Promise<ToolCallOutcome>((resolve) => {
        // The timeout clears the hold itself, so a turn that gave up leaves nothing behind for
        // a late result to find — and a late result then reports, which is what `settle` is for.
        const timer = setTimeout(() => {
          waiting.delete(turnId);
          resolve({ ok: false, message: "the gadget did not report back in time" });
        }, timeoutMs);
        // A wait is not a reason for the process to stay up.
        timer.unref();

        waiting.set(turnId, (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        });
      });
    },

    settle(turnId, outcome) {
      const resolve = waiting.get(turnId);
      if (!resolve) return false;
      waiting.delete(turnId);
      resolve(outcome);
      return true;
    },

    size() {
      return waiting.size;
    },
  };
}
