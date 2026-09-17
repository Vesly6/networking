/** A single shared pub/sub bus for the company-wide realtime events
 * companyRealtime.ts's one EventSource connection receives — added
 * because not every feature that wants to react to a live event has a
 * globally-reachable Zustand store the way the Team Activity Dashboard
 * and Instantly Unibox stores do (e.g. SmsInboxView.tsx keeps its own
 * local useState, not a store). Any component can subscribe to just the
 * event types it cares about while it's mounted, without companyRealtime.ts
 * needing to know that component exists. */

export interface CompanyRealtimeEvent {
  type: string;
  [key: string]: unknown;
}

const target = new EventTarget();
const EVENT_NAME = 'company-realtime-event';

export function publishCompanyEvent(event: CompanyRealtimeEvent): void {
  target.dispatchEvent(new CustomEvent<CompanyRealtimeEvent>(EVENT_NAME, { detail: event }));
}

/** Returns an unsubscribe function — call from a useEffect's cleanup. */
export function subscribeToCompanyEvents(handler: (event: CompanyRealtimeEvent) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<CompanyRealtimeEvent>).detail);
  target.addEventListener(EVENT_NAME, listener);
  return () => target.removeEventListener(EVENT_NAME, listener);
}
