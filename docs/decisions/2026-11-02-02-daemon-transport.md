# Daemon transport: the SDK's stdio transport over a Unix socket

Status: decided by the agent; the owner may reverse.

## Decision

Each daemon connection is served by `serveStdio(() => createMcpServer(store, inflight), { transport: new StdioServerTransport(socket, socket) })`. The proxy verifies one hello line and then pipes bytes. No HTTP, no custom JSON-RPC parsing in qmd.

## What was checked

- `@modelcontextprotocol/server` 2.0.0, `dist/stdio.d.mts`: `ServeStdioOptions.transport` is documented as "Bring your own transport (for example a `StdioServerTransport` constructed over a Unix domain socket or TCP stream, per the stdio binding's custom-transport guidance)"; `StdioServerTransport(stdin?: Readable, stdout?: Writable)` takes any streams.
- `serveStdio` pins one era per connection (2025 `initialize` or 2026 envelope), so Claude Code's 2025-era stdio protocol works unchanged through the pipe.
- The existing HTTP route (`startMcpHttpServer`) is stateless per request; its own comment says 2025-era clients need a stdio connection for anything after `initialize`, so proxying stdio into HTTP would break them.
- codegraph wrote its own `SocketTransport` and `MCPSession` because it does not use the SDK; qmd does.

## Options

| Option | Consequence | Reversal cost |
|---|---|---|
| SDK stdio transport over the socket (chosen) | zero protocol code; both eras; each connection gets its own `McpServer` from the existing factory | low |
| stdio to HTTP proxy into the existing HTTP server over a Unix socket | reuses `createMcpHandler`; breaks 2025-era clients past `initialize` | high |
| hand-written JSON-RPC relay like codegraph | duplicates the SDK | high |

## Consequences

`createMcpServer` is exported from `src/mcp/server.ts`; `startMcpServer` accepts an optional transport so the in-process fallback and the daemon share one code path.
