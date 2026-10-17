/**
 * PTY output to a WebSocket: low latency for echoes, bounded buffering for
 * floods.
 *
 * - Latency: the first chunk after a quiet spell is sent at once, so a
 *   keystroke's echo never waits. Chunks that follow within `batchMs` are
 *   coalesced into one message (up to `maxBatchBytes`), which keeps a busy
 *   stream to a few hundred messages a second.
 * - Flow control: the client acknowledges bytes once its terminal has parsed
 *   them. With more than `highWatermark` bytes unacknowledged the PTY is
 *   paused, and resumed once at most `lowWatermark` remain. A flood (`yes`,
 *   `cat bigfile`) then can't queue unbounded data in the server, the network
 *   or the browser, and Ctrl-C shows its effect without draining a backlog.
 */

export const DEFAULT_BATCH_MS = 4;
export const DEFAULT_MAX_BATCH_BYTES = 64 * 1024;
export const DEFAULT_HIGH_WATERMARK = 512 * 1024;
export const DEFAULT_LOW_WATERMARK = 128 * 1024;

/**
 * @param {object} options
 * @param {(chunk: Buffer) => void} options.send Sends one binary message
 * @param {() => void} options.pause Pauses the PTY
 * @param {() => void} options.resume Resumes the PTY
 * @param {number} [options.batchMs]
 * @param {number} [options.maxBatchBytes]
 * @param {number} [options.highWatermark]
 * @param {number} [options.lowWatermark]
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimer]
 * @param {(timer: unknown) => void} [options.clearTimer]
 */
export function createPtyOutput({
  send,
  pause,
  resume,
  batchMs = DEFAULT_BATCH_MS,
  maxBatchBytes = DEFAULT_MAX_BATCH_BYTES,
  highWatermark = DEFAULT_HIGH_WATERMARK,
  lowWatermark = DEFAULT_LOW_WATERMARK,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let pending = [];
  let pendingBytes = 0;
  /** Set while a batch window is open: chunks wait for it instead of going out at once */
  let timer = null;
  let unacknowledged = 0;
  let paused = false;
  let disposed = false;

  function flush() {
    if (pendingBytes === 0) return;
    const chunk = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    unacknowledged += chunk.length;
    send(chunk);
    if (!paused && unacknowledged > highWatermark) {
      paused = true;
      pause();
    }
  }

  function closeWindow() {
    timer = null;
    // Data kept coming: send it and keep batching; otherwise the next chunk goes out at once
    if (pendingBytes > 0) {
      flush();
      timer = setTimer(closeWindow, batchMs);
    }
  }

  return {
    /** Queues PTY output: sent now after a quiet spell, else with the current batch. */
    push(chunk) {
      if (disposed || chunk.length === 0) return;
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (timer === null) {
        flush();
        timer = setTimer(closeWindow, batchMs);
      } else if (pendingBytes >= maxBatchBytes) {
        flush();
      }
    },

    /** The client parsed `bytes` more bytes. */
    ack(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return;
      unacknowledged = Math.max(0, unacknowledged - bytes);
      if (paused && unacknowledged <= lowWatermark) {
        paused = false;
        resume();
      }
    },

    /** Bytes sent and not yet acknowledged. */
    get unacknowledged() {
      return unacknowledged;
    },

    get paused() {
      return paused;
    },

    /** Sends what the current batch window holds now (e.g. before the PTY's exit notice). */
    flush() {
      if (!disposed) flush();
    },

    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending = [];
      pendingBytes = 0;
    },
  };
}
