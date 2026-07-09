import assert from "node:assert";
import { DomainEventKind, type DomainEvent } from "@owner-operator/core";
import { InMemoryEventBus } from "./event-bus";

const bus = new InMemoryEventBus();
const received: DomainEvent[] = [];

bus.subscribe(() => { throw new Error("one consumer must not break another"); });
bus.subscribe(async (event) => { received.push(event); });

const event: DomainEvent = {
  kind: DomainEventKind.ThreadChanged,
  threadId: "thread-1",
  state: "needs-you",
  lastMessageAt: "2026-07-09T10:00:00.000Z",
  needsEnrichment: true,
};

assert.doesNotThrow(() => bus.publish(event), "publish is fail-isolated");
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(received, [event], "all healthy subscribers receive the event");

process.stdout.write("ok — in-memory domain event bus\n");
