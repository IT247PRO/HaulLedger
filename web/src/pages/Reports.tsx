import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatCents, label } from '../api';
import { ErrorText, Field, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks';

const firstOfMonth = () => new Date().toISOString().slice(0, 8) + '01';
const today = () => new Date().toISOString().slice(0, 10);
const perMile = (c: number | null) => (c === null ? '—' : `${formatCents(c)}/mi`);

export function Reports() {
  const [range, setRange] = useState({ from: firstOfMonth(), to: today() });
  const pnl = useApi<any>(`/reports/pnl?from=${range.from}&to=${range.to}`);
  const aging = useApi<any>('/reports/ar-aging');
  const [view, setView] = useState<'truck' | 'load'>('truck');

  return (
    <div className="space-y-6">
      <PageHeader title="Reports">
        <Field label="From"><input className="input" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
        <Field label="To"><input className="input" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
      </PageHeader>

      <section className="card space-y-3 overflow-x-auto">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">Profit &amp; loss</h2>
          <div className="flex gap-1 text-sm">
            <button className={view === 'truck' ? 'btn' : 'btn-secondary'} onClick={() => setView('truck')}>Per truck</button>
            <button className={view === 'load' ? 'btn' : 'btn-secondary'} onClick={() => setView('load')}>Per load</button>
          </div>
        </div>
        <p className="text-sm text-slate-500">
          Revenue from loads delivered in the period. Driver pay is actual for settled loads; for unsettled loads it is computed from the driver's pay rates and shown as <em>est.</em>
        </p>
        <ErrorText error={pnl.error} />
        {!pnl.data ? <Loading /> : view === 'truck' ? (
          <table className="table">
            <thead>
              <tr><th>Truck</th><th className="text-right">Loads</th><th className="text-right">Miles</th><th className="text-right">Revenue</th><th className="text-right">Driver pay</th><th className="text-right">Fuel (net)</th><th className="text-right">Other costs</th><th className="text-right">Net</th><th className="text-right">Rev/mi</th><th className="text-right">Cost/mi</th></tr>
            </thead>
            <tbody>
              {[...pnl.data.trucks, pnl.data.total].map((t: any) => (
                <tr key={t.key} className={t.key === 'total' ? 'font-semibold' : ''}>
                  <td title={Object.entries(t.expenses_by_category).map(([k, v]) => `${label(k)} ${formatCents(v as number)}`).join('\n')}>{t.label}</td>
                  <td className="text-right">{t.load_count}</td>
                  <td className="text-right tabular-nums">{(t.loaded_miles + t.empty_miles).toLocaleString()}</td>
                  <td className="text-right tabular-nums">{formatCents(t.revenue_cents)}</td>
                  <td className="text-right tabular-nums">
                    {formatCents(t.driver_pay_cents + t.driver_pay_estimated_cents)}
                    {t.driver_pay_estimated_cents > 0 && <div className="text-xs font-normal text-slate-500">incl. {formatCents(t.driver_pay_estimated_cents)} est.</div>}
                  </td>
                  <td className="text-right tabular-nums">{formatCents(t.fuel_cents - t.fuel_recovered_cents)}</td>
                  <td className="text-right tabular-nums">{formatCents(t.expenses_cents + t.reimbursements_cents)}</td>
                  <td className={`text-right tabular-nums ${t.net_cents < 0 ? 'text-red-700' : 'text-green-800'}`}>{formatCents(t.net_cents)}</td>
                  <td className="text-right tabular-nums">{perMile(t.revenue_per_mile_cents)}</td>
                  <td className="text-right tabular-nums">{perMile(t.cost_per_mile_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="table">
            <thead><tr><th>Load</th><th>Lane</th><th className="text-right">Miles</th><th className="text-right">Revenue</th><th className="text-right">Driver pay</th><th className="text-right">Fuel</th><th className="text-right">Other</th><th className="text-right">Net</th><th className="text-right">Rev/mi</th></tr></thead>
            <tbody>
              {pnl.data.loads.map((l: any) => (
                <tr key={l.key}>
                  <td><Link className="text-blue-700" to={`/loads/${l.key}`}>{l.load_number}</Link></td>
                  <td>{l.lane}</td>
                  <td className="text-right tabular-nums">{l.loaded_miles + l.empty_miles}</td>
                  <td className="text-right tabular-nums">{formatCents(l.revenue_cents)}</td>
                  <td className="text-right tabular-nums">{formatCents(l.driver_pay_cents + l.driver_pay_estimated_cents)}{l.pay_basis === 'estimated' && <span className="text-xs text-slate-500"> est.</span>}{l.pay_basis === 'none' && <span className="text-xs text-amber-700"> no rate</span>}</td>
                  <td className="text-right tabular-nums">{formatCents(l.fuel_cents - l.fuel_recovered_cents)}</td>
                  <td className="text-right tabular-nums">{formatCents(l.expenses_cents + l.reimbursements_cents)}</td>
                  <td className={`text-right tabular-nums ${l.net_cents < 0 ? 'text-red-700' : ''}`}>{formatCents(l.net_cents)}</td>
                  <td className="text-right tabular-nums">{perMile(l.revenue_per_mile_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card overflow-x-auto">
        <h2 className="mb-2 font-medium">Receivables aging</h2>
        {!aging.data ? <Loading /> : aging.data.customers.length === 0 ? <p className="text-sm text-slate-500">Nothing outstanding.</p> : (
          <table className="table">
            <thead><tr><th>Customer</th><th className="text-right">Current</th><th className="text-right">1–30</th><th className="text-right">31–60</th><th className="text-right">61–90</th><th className="text-right">90+</th><th className="text-right">Total</th></tr></thead>
            <tbody>
              {[...aging.data.customers, { customer_id: 'total', customer_name: 'Total', ...aging.data.total }].map((r: any) => (
                <tr key={r.customer_id} className={r.customer_id === 'total' ? 'font-semibold' : ''}>
                  <td>{r.customer_name}</td>
                  {['current', '1_30', '31_60', '61_90', 'over_90', 'total'].map((b) => <td key={b} className={`text-right tabular-nums ${b === 'over_90' && r[b] > 0 ? 'text-red-700' : ''}`}>{formatCents(r[b])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
