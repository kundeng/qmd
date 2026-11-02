/**
 * The daemon's view of its clients: who is connected, when bytes last arrived,
 * and whether the process should still be alive. Pure bookkeeping, so the
 * refcount, idle and backstop decisions are unit-testable without sockets.
 *
 * Three guards keep a daemon from outliving its clients:
 *   - the idle timer: armed when the last client leaves, cancelled by the next;
 *   - the inactivity backstop: after `maxIdleMs` without inbound bytes, exit
 *     unless some client's peer pid is provably alive (a quiet but live
 *     session must never be cut);
 *   - the dead-peer sweep: drop any client whose proxy pid or host pid is gone,
 *     for the case where a socket close is never delivered.
 */

import type { ClientHello } from "./paths.js";

export type ClientPeers = Pick<ClientHello, "pid" | "hostPid"> | null;

export type ClientEntry<T> = {
  handle: T;
  peers: ClientPeers;
  connectedAt: number;
};

/** Decides whether a peer process is gone. `kill(pid, 0)` in production. */
export type IsAlive = (pid: number) => boolean;

export function peerIsDead(peers: ClientPeers, isAlive: IsAlive): boolean {
  if (!peers) return false;
  if (!isAlive(peers.pid)) return true;
  if (peers.hostPid !== null && !isAlive(peers.hostPid)) return true;
  return false;
}

export class ClientRegistry<T> {
  private readonly clients = new Map<T, ClientEntry<T>>();
  private lastActivityAt: number;

  constructor(private readonly now: () => number = Date.now) {
    this.lastActivityAt = now();
  }

  get size(): number {
    return this.clients.size;
  }

  add(handle: T, peers: ClientPeers): void {
    this.clients.set(handle, { handle, peers, connectedAt: this.now() });
    this.lastActivityAt = this.now();
  }

  remove(handle: T): boolean {
    return this.clients.delete(handle);
  }

  has(handle: T): boolean {
    return this.clients.has(handle);
  }

  /** Record an inbound byte from any client. */
  touch(): void {
    this.lastActivityAt = this.now();
  }

  entries(): ClientEntry<T>[] {
    return [...this.clients.values()];
  }

  /** Clients whose peer process is gone; the caller closes and removes them. */
  deadClients(isAlive: IsAlive): ClientEntry<T>[] {
    return this.entries().filter((entry) => peerIsDead(entry.peers, isAlive));
  }

  /**
   * Whether the inactivity backstop should end the daemon: only when clients
   * are connected, nothing has arrived for `maxIdleMs`, and no remaining
   * client can be proven alive. The idle timer owns the zero-client case.
   */
  shouldBackstopExit(maxIdleMs: number, isAlive: IsAlive): boolean {
    if (maxIdleMs <= 0 || this.clients.size === 0) return false;
    if (this.now() - this.lastActivityAt < maxIdleMs) return false;
    const live = this.entries().filter((entry) => !peerIsDead(entry.peers, isAlive));
    return !live.some((entry) => entry.peers !== null);
  }
}
