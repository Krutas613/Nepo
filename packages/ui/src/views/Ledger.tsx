import { useMemo, useState, type ReactElement } from 'react';
import { STANDARD_CHART } from '@nepo/sim/accounting';
import { calendarFromTick } from '@nepo/sim/engine';
import type { JournalEntry } from '@nepo/sim/schema';
import {
  DataTable,
  Money,
  Panel,
  Select,
  type Column,
  type SelectOption,
} from '../components/index.js';
import { formatDate } from '../format/index.js';
import { useSelector } from '../sim/hooks.js';
import { usePlayerId } from '../sim/queries-hooks.js';
import { accountName, displayCode } from '../sim/selectors.js';

const ACCOUNT_OPTIONS: SelectOption<string>[] = [
  { value: 'all', label: 'All accounts' },
  ...STANDARD_CHART.map((a) => ({ value: a.code, label: `${displayCode(a.code)} ${a.name}` })),
];

function entryAmount(e: JournalEntry): number {
  return e.lines.reduce((sum, l) => sum + l.debit, 0);
}

export function filterEntries(
  journal: readonly JournalEntry[],
  entityId: string | null,
  account: string,
  query: string,
): readonly JournalEntry[] {
  const q = query.trim().toLowerCase();
  if (account === 'all' && q === '' && entityId === null) return journal;
  return journal.filter(
    (e) =>
      (entityId === null || e.entityId === entityId) &&
      (account === 'all' || e.lines.some((l) => l.account === account)) &&
      (q === '' || e.memo.toLowerCase().includes(q) || e.source.includes(q)),
  );
}

export function Ledger(): ReactElement {
  const playerId = usePlayerId();
  const [account, setAccount] = useState('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const epoch = useSelector((v) => v.world.state.epochYear);
  // The journal is append-only and mutated in place: key memoization on its length.
  const { journal, count } = useSelector(
    (v) => ({
      journal: v.world.state.accounting.journal,
      count: v.world.state.accounting.journal.length,
    }),
    (a, b) => a.journal === b.journal && a.count === b.count,
  );

  const rows = useMemo(
    () => filterEntries(journal, playerId, account, query),
    [journal, count, playerId, account, query],
  );
  const selected = selectedId === null ? null : (rows.find((e) => e.id === selectedId) ?? null);

  const columns: Column<JournalEntry>[] = useMemo(
    () => [
      {
        key: 'id',
        header: 'Entry',
        width: '110px',
        render: (e) => <span className="num">{e.id}</span>,
      },
      {
        key: 'date',
        header: 'Date',
        width: '120px',
        render: (e) => <span className="num">{formatDate(calendarFromTick(e.tick, epoch))}</span>,
      },
      { key: 'source', header: 'Source', width: '110px', render: (e) => e.source },
      { key: 'memo', header: 'Memo', width: 'minmax(200px, 2fr)', render: (e) => e.memo },
      {
        key: 'lines',
        header: 'Accounts',
        width: 'minmax(200px, 2fr)',
        render: (e) => (
          <span className="muted">
            {e.lines
              .map((l) => `${l.debit > 0 ? 'Dr' : 'Cr'} ${displayCode(l.account)}`)
              .join(' · ')}
          </span>
        ),
      },
      {
        key: 'amount',
        header: 'Amount',
        width: '140px',
        align: 'right',
        render: (e) => <Money value={entryAmount(e)} />,
      },
    ],
    [epoch],
  );

  return (
    <div className="view view-fill">
      <Panel
        fill
        flush
        title={`Journal (${String(rows.length)} of ${String(count)} entries)`}
        actions={
          <div className="toolbar">
            <label className="toolbar-label" htmlFor="ledger-account">
              Account
            </label>
            <Select
              id="ledger-account"
              value={account}
              options={ACCOUNT_OPTIONS}
              onChange={setAccount}
            />
            <input
              className="field"
              placeholder="Search memo or source"
              aria-label="Search journal"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
            />
          </div>
        }
      >
        <div className="fill-split">
          <DataTable
            aria-label="Journal entries"
            rows={rows}
            reverse
            columns={columns}
            rowKey={(e) => e.id}
            selectedKey={selected?.id ?? null}
            onRowClick={(e) => {
              setSelectedId(e.id === selectedId ? null : e.id);
            }}
            empty="No journal entries match."
          />
          {selected !== null && (
            <div className="entry-detail">
              <div className="entry-detail-head">
                <strong>{selected.id}</strong> <span className="muted">{selected.memo}</span>
              </div>
              <table className="stmt">
                <tbody>
                  {selected.lines.map((l, i) => (
                    <tr key={i} className="stmt-line">
                      <td className="stmt-code num">{displayCode(l.account)}</td>
                      <td className="stmt-label">{accountName(l.account)}</td>
                      <td className="stmt-amount">
                        {l.debit > 0 ? <Money value={l.debit} tint={false} /> : null}
                      </td>
                      <td className="stmt-amount">
                        {l.credit > 0 ? <Money value={l.credit} tint={false} /> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
