import { useMemo, useState, type ReactElement } from 'react';
import { Money, Panel, Select, Tabs, type SelectOption } from '../components/index.js';
import { formatPeriod } from '../format/index.js';
import { useSelector } from '../sim/hooks.js';
import { usePlayerId, usePlayerReports } from '../sim/queries-hooks.js';
import { liveReport } from '../sim/queries.js';
import type { PeriodKind, PeriodReport } from '@nepo/sim/schema';
import {
  balanceSheetRows,
  cashFlowRows,
  incomeStatementRows,
  type StatementRow,
} from './statementRows.js';

type StatementId = 'income' | 'balance' | 'cashflow';
type KindChoice = PeriodKind;

const STATEMENT_TABS = [
  { id: 'income', label: 'Income statement' },
  { id: 'balance', label: 'Balance sheet' },
  { id: 'cashflow', label: 'Cash flow' },
] as const;

const KIND_OPTIONS: SelectOption<KindChoice>[] = [
  { value: 'month', label: 'Monthly' },
  { value: 'quarter', label: 'Quarterly' },
  { value: 'year', label: 'Annual' },
];

const LIVE = 'live';

function reportId(r: PeriodReport): string {
  return `${r.kind}:${String(r.year)}:${String(r.month)}`;
}

function StatementTable({ rows }: { rows: readonly StatementRow[] }): ReactElement {
  return (
    <table className="stmt">
      <tbody>
        {rows.map((r, i) => {
          if (r.kind === 'spacer')
            return (
              <tr key={i} className="stmt-spacer" aria-hidden="true">
                <td colSpan={3} />
              </tr>
            );
          return (
            <tr key={i} className={`stmt-${r.kind}`}>
              <td className="stmt-code num">{r.code ?? ''}</td>
              <td className="stmt-label">{r.label}</td>
              <td className="stmt-amount">
                {r.amount === undefined ? null : (
                  <Money value={r.amount} negative="parens" plain={false} />
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function Statements(): ReactElement {
  const [statement, setStatement] = useState<StatementId>('income');
  const [kind, setKind] = useState<KindChoice>('month');
  const [period, setPeriod] = useState<string>(LIVE);
  const playerId = usePlayerId();
  const { reports, count } = usePlayerReports();
  // The live report changes daily; compare by value so the table re-renders only when it differs.
  const live = useSelector(
    (v) => liveReport(v.world.state, playerId),
    (a, b) => JSON.stringify(a) === JSON.stringify(b),
  );

  const ofKind = useMemo(
    () => reports.filter((r) => r.kind === kind).reverse(),
    [reports, count, kind],
  );
  const options: SelectOption<string>[] = useMemo(
    () => [
      { value: LIVE, label: 'Live (month to date)' },
      ...ofKind.map((r) => ({ value: reportId(r), label: formatPeriod(r.kind, r.year, r.month) })),
    ],
    [ofKind],
  );

  const selected: PeriodReport | null =
    period === LIVE ? live : (ofKind.find((r) => reportId(r) === period) ?? null);
  const effectivePeriod = selected === null ? LIVE : period;
  const report = selected ?? live;

  let rows: StatementRow[] = [];
  if (report !== null) {
    rows =
      statement === 'income'
        ? incomeStatementRows(report.income)
        : statement === 'balance'
          ? balanceSheetRows(report.balance)
          : cashFlowRows(report.cashFlow);
  }
  const title =
    effectivePeriod === LIVE
      ? 'Live: month to date'
      : report === null
        ? ''
        : formatPeriod(report.kind, report.year, report.month);

  return (
    <div className="view">
      <Panel
        title="Financial statements"
        actions={
          <div className="toolbar">
            <label className="toolbar-label" htmlFor="stmt-kind">
              Period type
            </label>
            <Select
              id="stmt-kind"
              value={kind}
              options={KIND_OPTIONS}
              onChange={(k) => {
                setKind(k);
                setPeriod(LIVE);
              }}
            />
            <label className="toolbar-label" htmlFor="stmt-period">
              Period
            </label>
            <Select
              id="stmt-period"
              value={effectivePeriod}
              options={options}
              onChange={setPeriod}
            />
          </div>
        }
      >
        <Tabs
          tabs={STATEMENT_TABS}
          value={statement}
          onChange={setStatement}
          aria-label="Statement"
        />
        <div className="stmt-wrap">
          <div className="stmt-title">
            <strong>{title}</strong>
            {effectivePeriod === LIVE && statement === 'balance' && (
              <span className="muted"> &middot; balances as of today</span>
            )}
            {effectivePeriod === LIVE && statement !== 'balance' && (
              <span className="muted"> &middot; resets at month end</span>
            )}
          </div>
          {report === null ? (
            <p className="note">No company ledger.</p>
          ) : (
            <StatementTable rows={rows} />
          )}
        </div>
      </Panel>
    </div>
  );
}
