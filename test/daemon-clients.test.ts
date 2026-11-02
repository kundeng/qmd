/**
 * Refcount, inactivity backstop and dead-peer sweep decisions, with an
 * injected clock and liveness probe.
 */
import { describe, test, expect } from "vitest";
import { ClientRegistry, peerIsDead } from "../src/daemon/clients.ts";

function registry(start = 1_000_000) {
  let now = start;
  const reg = new ClientRegistry<string>(() => now);
  return { reg, advance: (ms: number) => { now += ms; } };
}

describe("peerIsDead", () => {
  test("unknown peers are never dead; a dead proxy or host pid is", () => {
    const alive = (pid: number) => pid === 1;
    expect(peerIsDead(null, alive)).toBe(false);
    expect(peerIsDead({ pid: 1, hostPid: null }, alive)).toBe(false);
    expect(peerIsDead({ pid: 2, hostPid: null }, alive)).toBe(true);
    expect(peerIsDead({ pid: 1, hostPid: 2 }, alive)).toBe(true);
    expect(peerIsDead({ pid: 1, hostPid: 1 }, alive)).toBe(false);
  });
});

describe("ClientRegistry", () => {
  test("counts connected clients", () => {
    const { reg } = registry();
    expect(reg.size).toBe(0);
    reg.add("a", { pid: 10, hostPid: null });
    reg.add("b", null);
    expect(reg.size).toBe(2);
    expect(reg.has("a")).toBe(true);
    expect(reg.remove("a")).toBe(true);
    expect(reg.remove("a")).toBe(false);
    expect(reg.size).toBe(1);
  });

  test("deadClients names only clients with a dead known peer", () => {
    const { reg } = registry();
    reg.add("live", { pid: 10, hostPid: 11 });
    reg.add("deadProxy", { pid: 20, hostPid: null });
    reg.add("deadHost", { pid: 30, hostPid: 31 });
    reg.add("unknown", null);
    const alive = (pid: number) => [10, 11, 30].includes(pid);
    expect(reg.deadClients(alive).map((e) => e.handle).sort()).toEqual(["deadHost", "deadProxy"]);
  });

  test("backstop never fires with no clients, within the window, or with a provably live client", () => {
    const { reg, advance } = registry();
    const everyoneAlive = () => true;
    expect(reg.shouldBackstopExit(1000, everyoneAlive)).toBe(false);
    reg.add("a", { pid: 10, hostPid: null });
    advance(500);
    expect(reg.shouldBackstopExit(1000, everyoneAlive)).toBe(false);
    advance(600);
    // 1100 ms quiet, but a live known peer keeps the daemon up.
    expect(reg.shouldBackstopExit(1000, everyoneAlive)).toBe(false);
    reg.touch();
    advance(1100);
    expect(reg.shouldBackstopExit(1000, everyoneAlive)).toBe(false);
  });

  test("backstop fires when every remaining client is an unknown-pid phantom", () => {
    const { reg, advance } = registry();
    reg.add("phantom", null);
    advance(1100);
    expect(reg.shouldBackstopExit(1000, () => true)).toBe(true);
    expect(reg.shouldBackstopExit(0, () => true)).toBe(false);
  });

  test("backstop ignores dead known peers when deciding", () => {
    const { reg, advance } = registry();
    reg.add("dead", { pid: 20, hostPid: null });
    reg.add("phantom", null);
    advance(2000);
    // The dead peer does not count as live; only a phantom remains.
    expect(reg.shouldBackstopExit(1000, () => false)).toBe(true);
    reg.add("live", { pid: 10, hostPid: null });
    expect(reg.shouldBackstopExit(1000, (pid) => pid === 10)).toBe(false);
  });

  test("add and touch count as activity", () => {
    const { reg, advance } = registry();
    reg.add("phantom", null);
    advance(900);
    reg.touch();
    advance(900);
    expect(reg.shouldBackstopExit(1000, () => true)).toBe(false);
    advance(200);
    expect(reg.shouldBackstopExit(1000, () => true)).toBe(true);
  });
});
