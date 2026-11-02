/**
 * Daemon rendezvous paths and hello codecs.
 */
import { describe, test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  indexKey,
  daemonPaths,
  canonicalDbPath,
  encodeHello,
  parseDaemonHello,
  parseClientHello,
  qmdPackageVersion,
  envMs,
  daemonOptOut,
  HELLO_PROTOCOL,
} from "../src/daemon/paths.ts";

describe("indexKey and daemonPaths", () => {
  test("the same index spelled two ways gets one key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qmd-paths-"));
    try {
      const a = indexKey(join(dir, "index.sqlite"));
      const b = indexKey(join(dir, ".", "sub", "..", "index.sqlite"));
      expect(a).toMatch(/^[0-9a-f]{16}$/);
      expect(b).toBe(a);
      expect(indexKey(join(dir, "other.sqlite"))).not.toBe(a);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runtime files live under the qmd cache run dir, keyed by the index", () => {
    const prev = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = "/tmp/qmd-xdg";
    try {
      const paths = daemonPaths("/tmp/some/index.sqlite");
      const key = indexKey("/tmp/some/index.sqlite");
      expect(paths.dir).toBe(`/tmp/qmd-xdg/qmd/run/${key}`);
      expect(paths.pidPath).toBe(`${paths.dir}/daemon.pid`);
      expect(paths.logPath).toBe(`${paths.dir}/daemon.log`);
      expect(paths.infoPath).toBe(`${paths.dir}/index.json`);
      expect(paths.socketPath).toBe(`${paths.dir}/daemon.sock`);
    } finally {
      if (prev === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = prev;
    }
  });

  test("a socket path past the sun_path limit relocates to the temp dir", () => {
    const prev = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = "/tmp/" + "deep/".repeat(30);
    try {
      const paths = daemonPaths("/tmp/x/index.sqlite");
      expect(paths.socketPath.startsWith(tmpdir())).toBe(true);
      expect(paths.socketPath).toContain(indexKey("/tmp/x/index.sqlite"));
      expect(paths.pidPath.startsWith(process.env.XDG_CACHE_HOME!)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = prev;
    }
  });

  test("canonicalDbPath resolves a missing file against its existing parent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qmd-canon-"));
    try {
      expect(canonicalDbPath(join(dir, "missing.sqlite"))).toBe(join(await realpath(dir), "missing.sqlite"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function realpath(p: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(p);
}

describe("hello codecs", () => {
  test("daemon hello round-trips and rejects other shapes", () => {
    const hello = { qmd: "2.8.3", pid: 42, dbPath: "/x/index.sqlite", protocol: HELLO_PROTOCOL };
    const line = encodeHello(hello);
    expect(line.endsWith("\n")).toBe(true);
    expect(parseDaemonHello(line.trimEnd())).toEqual(hello);
    expect(parseDaemonHello('{"jsonrpc":"2.0","id":1,"method":"initialize"}')).toBeNull();
    expect(parseDaemonHello("not json")).toBeNull();
    expect(parseDaemonHello('{"qmd":"2.8.3","pid":"42","dbPath":"/x","protocol":1}')).toBeNull();
  });

  test("client hello round-trips; hostPid is optional", () => {
    expect(parseClientHello(encodeHello({ qmd_client: 1, pid: 7, hostPid: 3 }).trimEnd())).toEqual({ qmd_client: 1, pid: 7, hostPid: 3 });
    expect(parseClientHello('{"qmd_client":1,"pid":7}')).toEqual({ qmd_client: 1, pid: 7, hostPid: null });
    expect(parseClientHello('{"qmd_client":2,"pid":7}')).toBeNull();
    expect(parseClientHello('{"jsonrpc":"2.0","id":1,"method":"initialize"}')).toBeNull();
  });

  test("package version is the package.json version", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };
    expect(qmdPackageVersion()).toBe(pkg.version);
  });
});

describe("env parsing", () => {
  test("envMs falls back on unset, empty, negative and non-numeric", () => {
    const name = "QMD_TEST_MS_" + process.pid;
    delete process.env[name];
    expect(envMs(name, 5)).toBe(5);
    process.env[name] = "";
    expect(envMs(name, 5)).toBe(5);
    process.env[name] = "-1";
    expect(envMs(name, 5)).toBe(5);
    process.env[name] = "abc";
    expect(envMs(name, 5)).toBe(5);
    process.env[name] = "0";
    expect(envMs(name, 5)).toBe(0);
    process.env[name] = "250.7";
    expect(envMs(name, 5)).toBe(250);
    delete process.env[name];
  });

  test("daemonOptOut reads QMD_NO_DAEMON", () => {
    const prev = process.env.QMD_NO_DAEMON;
    try {
      delete process.env.QMD_NO_DAEMON;
      expect(daemonOptOut()).toBe(false);
      process.env.QMD_NO_DAEMON = "1";
      expect(daemonOptOut()).toBe(true);
      process.env.QMD_NO_DAEMON = "true";
      expect(daemonOptOut()).toBe(true);
      process.env.QMD_NO_DAEMON = "0";
      expect(daemonOptOut()).toBe(false);
      process.env.QMD_NO_DAEMON = "off";
      expect(daemonOptOut()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.QMD_NO_DAEMON; else process.env.QMD_NO_DAEMON = prev;
    }
  });
});
