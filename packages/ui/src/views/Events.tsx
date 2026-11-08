import { useMemo, useState, type ReactElement } from 'react';
import { calendarFromTick } from '@nepo/sim/engine';
import { EVENT_TYPES, type Event } from '@nepo/sim/schema';
import { DataTable, Panel, Select, type Column, type SelectOption } from '../components/index.js';
import { formatDate } from '../format/index.js';
import { useSelector } from '../sim/hooks.js';
import {
  eventFilterOptions,
  firstEventAtOrAfter,
  matchesEventFilter,
  summarizeEvent,
} from './eventFilter.js';

const WINDOW_OPTIONS: SelectOption<string>[] = [
  { value: '1', label: 'Last day' },
  { value: '10', label: 'Last 10 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '360', label: 'Last year' },
  { value: 'all', label: 'Everything buffered' },
];

export function Events(): ReactElement {
  const [filter, setFilter] = useState('all');
  const [span, setSpan] = useState('30');
  const events = useSelector((v) => v.events);
  const tick = useSelector((v) => v.tick);
  const epoch = useSelector((v) => v.world.state.epochYear);

  const typeOptions = useMemo(
    () => eventFilterOptions([...EVENT_TYPES, ...events.map((e) => e.type)]),
    [events],
  );

  const rows = useMemo(() => {
    const minTick = span === 'all' ? 0 : Math.max(0, tick - Number(span));
    const start = firstEventAtOrAfter(events, minTick);
    const slice = start === 0 ? events : events.slice(start);
    return filter === 'all' ? slice : slice.filter((e) => matchesEventFilter(e.type, filter));
  }, [events, tick, span, filter]);

  const columns: Column<Event>[] = useMemo(
    () => [
      {
        key: 'date',
        header: 'Date',
        width: '150px',
        render: (e) => <span className="num">{formatDate(calendarFromTick(e.tick, epoch))}</span>,
      },
      {
        key: 'tick',
        header: 'Tick',
        width: '70px',
        align: 'right',
        render: (e) => <span className="num">{e.tick}</span>,
      },
      { key: 'source', header: 'Source', width: '110px', render: (e) => e.source },
      {
        key: 'type',
        header: 'Type',
        width: '170px',
        render: (e) => <span className="num">{e.type}</span>,
      },
      {
        key: 'summary',
        header: 'Detail',
        width: 'minmax(260px, 1fr)',
        render: (e) => summarizeEvent(e),
      },
    ],
    [epoch],
  );

  return (
    <div className="view view-fill">
      <Panel
        fill
        flush
        title={`Event log (${String(rows.length)})`}
        actions={
          <div className="toolbar">
            <Select
              aria-label="Time window"
              value={span}
              options={WINDOW_OPTIONS}
              onChange={setSpan}
            />
            <Select
              aria-label="Event type"
              value={filter}
              options={typeOptions}
              onChange={setFilter}
            />
          </div>
        }
      >
        <DataTable
          aria-label="Events"
          rows={rows}
          reverse
          columns={columns}
          rowKey={(_e, i) => String(i)}
          rowClassName={(e) => (e.type === 'command.rejected' ? 'row-alert' : undefined)}
          empty="No events in this window."
        />
      </Panel>
    </div>
  );
}
