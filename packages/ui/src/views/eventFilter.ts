import type { Event } from '@nepo/sim/schema';

/** Filter value: `all`, `prefix:<group>` (text before the first dot) or `type:<full type>`. */
export type EventFilter = string;

export function matchesEventFilter(type: string, filter: EventFilter): boolean {
  if (filter === 'all') return true;
  if (filter.startsWith('prefix:')) return type.startsWith(`${filter.slice(7)}.`);
  if (filter.startsWith('type:')) return type === filter.slice(5);
  return true;
}

/** Filter choices from every known/seen event type: `all`, then groups, then exact types. */
export function eventFilterOptions(
  types: Iterable<string>,
): { value: EventFilter; label: string }[] {
  const all = [...new Set(types)].sort();
  const groups = [...new Set(all.map((t) => t.split('.')[0] ?? t))].sort();
  return [
    { value: 'all', label: 'All events' },
    ...groups.map((g) => ({ value: `prefix:${g}`, label: `${g}.*` })),
    ...all.map((t) => ({ value: `type:${t}`, label: t })),
  ];
}

/** Index of the first event with `tick >= minTick` (events are in tick order). */
export function firstEventAtOrAfter(events: readonly Event[], minTick: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((events[mid]?.tick ?? 0) < minTick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** One-line description of an event for the log. Unknown types fall back to `key=value` pairs. */
export function summarizeEvent(e: Event): string {
  if (e.type === 'command.rejected') {
    return `${e.payload.commandType} #${String(e.payload.commandSeq)} rejected (${e.payload.code}): ${e.payload.reason}`;
  }
  if (e.type === 'company.renamed') return `${e.payload.companyId} renamed to "${e.payload.name}"`;
  if (e.type === 'company.founded') return `${e.payload.companyId} founded as "${e.payload.name}"`;
  if (e.type === 'ledger.posted') return `${e.payload.entityId}: ${e.payload.memo}`;
  if (e.type === 'period.closed') {
    return `${e.payload.entityId} ${e.payload.kind} closed Y${String(e.payload.year)} M${String(e.payload.month)}`;
  }
  const payload = (e as unknown as { payload?: Record<string, unknown> }).payload ?? {};
  return Object.keys(payload)
    .sort()
    .map((k) => `${k}=${JSON.stringify(payload[k])}`)
    .join(' ');
}
