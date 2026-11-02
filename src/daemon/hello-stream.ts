/**
 * Reading one optional line from the head of a socket without losing what
 * follows it. Used by the daemon for the client hello and by the proxy for
 * the daemon hello.
 */

import type { Socket } from "node:net";
import { MAX_HELLO_LINE_BYTES } from "./paths.js";

export type FirstLine = { line: string; tail: Buffer } | { line: null; tail: Buffer };

/**
 * Resolve with the first newline-terminated line and the bytes after it, or
 * with `line: null` and every byte seen when no line arrives in time, the
 * data grows past the hello limit, or the socket ends. The socket is paused
 * before resolving, so the caller attaches its own listener and resumes; the
 * tail is unshifted back onto the socket so that listener sees it first.
 */
export function readFirstLine(socket: Socket, timeoutMs: number): Promise<FirstLine> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (result: FirstLine): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onEnd);
      socket.removeListener("close", onEnd);
      socket.removeListener("end", onEnd);
      // Pause first: removing the last 'data' listener does not stop a flowing
      // stream, and bytes emitted to no listener are gone. The caller resumes.
      try { socket.pause(); } catch { /* stream already gone */ }
      if (result.tail.length > 0 && !socket.destroyed) {
        try { socket.unshift(result.tail); } catch { /* stream already gone */ }
      }
      resolve(result);
    };

    const onData = (chunk: Buffer | string): void => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      chunks.push(buf);
      total += buf.length;
      const all = chunks.length === 1 ? buf : Buffer.concat(chunks, total);
      const nl = all.indexOf(0x0a);
      if (nl === -1) {
        if (total > MAX_HELLO_LINE_BYTES) finish({ line: null, tail: all });
        else chunks.splice(0, chunks.length, all);
        return;
      }
      finish({ line: all.subarray(0, nl).toString("utf8"), tail: all.subarray(nl + 1) });
    };
    const onEnd = (): void => finish({ line: null, tail: Buffer.concat(chunks, total) });
    const timer = setTimeout(() => finish({ line: null, tail: Buffer.concat(chunks, total) }), timeoutMs);
    timer.unref?.();

    socket.on("data", onData);
    socket.on("error", onEnd);
    socket.on("close", onEnd);
    socket.on("end", onEnd);
  });
}
