import type { DomainEvent } from "@owner-operator/core";

export type DomainEventSubscriber = (event: DomainEvent) => void | Promise<void>;

/**
 * Process-local wake-up channel. SQLite remains truth: delivery is intentionally
 * best-effort, non-blocking, and isolated per subscriber.
 */
export class InMemoryEventBus {
  private readonly subscribers = new Set<DomainEventSubscriber>();

  subscribe(subscriber: DomainEventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  publish(event: DomainEvent): void {
    for (const subscriber of this.subscribers) {
      queueMicrotask(() => {
        try {
          void Promise.resolve(subscriber(event)).catch(() => undefined);
        } catch {
          // A wake-up consumer cannot fail the committed state mutation or its peers.
        }
      });
    }
  }
}
