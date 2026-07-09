# Gateway

Loopback HTTP/SSE transport and its client SDK. The server translates requests into injected
state/monitor/scheduler calls. It owns no SQLite connection, model call, scan, timer, or child
process. See [architecture](../../docs/architecture.md).
