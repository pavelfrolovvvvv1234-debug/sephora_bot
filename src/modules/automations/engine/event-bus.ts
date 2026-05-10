/**
 * In-process event bus for automation events. Optional: push to BullMQ for async.
 *
 * @module modules/automations/engine/event-bus
 */

import type { AutomationEventPayload } from "../events/types.js";

type Listener = (payload: AutomationEventPayload) => void | Promise<void>;

const listeners: Listener[] = [];

export function emit(payload: AutomationEventPayload): void {
  for (const fn of listeners) {
    try {
      const r = fn(payload);
      if (r && typeof (r as Promise<unknown>).catch === "function") {
        (r as Promise<void>).catch(() => {});
      }
    } catch (_) {}
  }
}

export function onEvent(fn: Listener): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}
