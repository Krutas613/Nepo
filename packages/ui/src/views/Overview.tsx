import { useMemo, type ReactElement } from 'react';
import { LineChart, Money, Panel, Stat } from '../components/index.js';
import { formatDate, formatMoneyCompact } from '../format/index.js';
import { calendarFromTick } from '@nepo/sim/engine';
import { useSelector } from '../sim/hooks.js';
import type { GameView } from '../sim/store.js';
import { usePlayerCash, usePlayerReports } from '../sim/queries-hooks.js';
import { latestReport, liveReport } from '../sim/queries.js';
import { playerCompanyId } from '../sim/selectors.js';
import { RenameCompanyForm } from './RenameCompanyForm.js';

const selectMtdNet = (v: GameView): number | null =>
  liveReport(v.world.state, playerCompanyId(v.world.state))?.income.netIncome ?? null;

export function Overview(): ReactElement {
  const cash = usePlayerCash();
  const mtdNet = useSelector(selectMtdNet);
  const equity = useSelector(
    (v) => liveReport(v.world.state, playerCompanyId(v.world.state))?.balance.equity ?? null,
  );
  const { reports } = usePlayerReports();
  const lastMonth = latestReport(reports, 'month');
  const series = useSelector((v) => v.cashSeries);
  const epoch = useSelector((v) => v.world.state.epochYear);
  const seed = useSelector((v) => v.seed);
  const tick = useSelector((v) => v.tick);
  const points = useMemo(() => series.map((p) => ({ x: p.tick, y: p.value })), [series]);

  return (
    <div className="view">
      <div className="stat-grid">
        <Stat label="Cash" value={cash === null ? '—' : <Money value={cash} />} />
        <Stat
          label="Net income, month to date"
          value={mtdNet === null ? '—' : <Money value={mtdNet} tintPositive />}
          hint="Live, from the open month"
        />
        <Stat
          label="Net income, last closed month"
          value={
            lastMonth === null ? '—' : <Money value={lastMonth.income.netIncome} tintPositive />
          }
          hint={
            lastMonth === null
              ? 'No month closed yet'
              : `Y${String(lastMonth.year)} M${String(lastMonth.month).padStart(2, '0')}`
          }
        />
        <Stat
          label="Equity"
          value={equity === null ? '—' : <Money value={equity} />}
          hint="Includes current earnings"
        />
      </div>

      <div className="grid-2">
        <Panel title="Cash balance">
          <LineChart
            aria-label="Cash balance over time"
            points={points}
            formatY={formatMoneyCompact}
            formatX={(x) => formatDate(calendarFromTick(Math.max(0, Math.round(x)), epoch))}
          />
        </Panel>
        <Panel title="Operations">
          <dl className="kv">
            <dt>Facilities</dt>
            <dd className="num muted">&mdash;</dd>
            <dt>Stores</dt>
            <dd className="num muted">&mdash;</dd>
            <dt>Employees</dt>
            <dd className="num muted">&mdash;</dd>
            <dt>Open loans</dt>
            <dd className="num muted">&mdash;</dd>
          </dl>
          <p className="note">
            Operating counts appear once the manufacturing, retail and finance systems are enabled.
          </p>
        </Panel>
      </div>

      <div className="grid-2">
        <Panel title="Company">
          <RenameCompanyForm />
        </Panel>
        <Panel title="Run">
          <dl className="kv">
            <dt>Seed</dt>
            <dd className="num">{seed}</dd>
            <dt>Day</dt>
            <dd className="num">{tick}</dd>
            <dt>Closed reports</dt>
            <dd className="num">{reports.length}</dd>
          </dl>
        </Panel>
      </div>
    </div>
  );
}
