import { Fragment, useEffect, useState } from 'react';
import { api, formatCents, formatScaled, parseDollars, parseScaled } from '../api';
import { ErrorText, Field, PageHeader } from '../components/ui';

type Form = Record<string, string>;
const FIELDS: { key: string; label: string; places: number; money?: boolean }[] = [
  { key: 'rate', label: 'Offered rate $', places: 2, money: true },
  { key: 'loaded_miles', label: 'Loaded miles', places: 0 },
  { key: 'deadhead_miles', label: 'Deadhead miles', places: 0 },
  { key: 'fuel_price', label: 'Diesel $/gal', places: 3 },
  { key: 'mpg', label: 'MPG', places: 2 },
  { key: 'pay_per_mile', label: 'Driver pay $/mi', places: 5 },
  { key: 'pay_percent', label: 'Driver pay % of rate', places: 2 },
  { key: 'maintenance', label: 'Maintenance reserve $/mi', places: 5 },
  { key: 'tolls', label: 'Tolls $', places: 2, money: true },
  { key: 'fixed_monthly', label: 'Fixed costs $/truck/month', places: 2, money: true },
  { key: 'miles_per_month', label: 'Miles/truck/month', places: 0 },
  { key: 'target_margin', label: 'Target margin %', places: 2 },
];

/** True all-in cost per mile against an offered rate, seeded from the carrier's actual last 90 days. */
export function RateCalculator() {
  const [form, setForm] = useState<Form>({ rate: '', loaded_miles: '', deadhead_miles: '0', pay_percent: '0', tolls: '0', target_margin: '15', fuel_price: '', mpg: '', pay_per_mile: '', maintenance: '', fixed_monthly: '', miles_per_month: '' });
  const [basis, setBasis] = useState<Record<string, string>>({});
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<any>('/rate-calculator/defaults').then((d) => {
      setBasis(d.basis);
      setForm((f) => ({
        ...f,
        fuel_price: d.fuel_price_x1000 !== null ? formatScaled(d.fuel_price_x1000, 3, 3) : '',
        mpg: d.mpg_x100 !== null ? formatScaled(d.mpg_x100, 2) : '',
        pay_per_mile: d.driver_pay_millicents_per_mile !== null ? formatScaled(d.driver_pay_millicents_per_mile, 5) : '',
        maintenance: d.maintenance_millicents_per_mile !== null ? formatScaled(d.maintenance_millicents_per_mile, 5) : '',
        fixed_monthly: formatScaled(d.fixed_monthly_cents, 2).replace(/,/g, ''),
        miles_per_month: d.miles_per_month !== null ? String(d.miles_per_month) : '',
      }));
    }).catch(() => undefined);
  }, []);

  async function calc() {
    const required = ['rate', 'loaded_miles', 'fuel_price', 'mpg', 'fixed_monthly', 'miles_per_month'];
    if (!(form.pay_per_mile ?? '').trim() && !Number(form.pay_percent)) required.push('pay_per_mile');
    const blank = required.filter((k) => !(form[k] ?? '').trim());
    if (blank.length) return setError(`Fill in: ${blank.map((k) => FIELDS.find((f) => f.key === k)?.label).join(', ')} — a blank cost would make the margin look better than it is`);
    const n = (k: string, places: number) => parseScaled((form[k] ?? '').replace(/,/g, '') || '0', places);
    const values = {
      rate_cents: parseDollars(form.rate ?? ''), loaded_miles: n('loaded_miles', 0), deadhead_miles: n('deadhead_miles', 0),
      fuel_price_x1000: n('fuel_price', 3), mpg_x100: n('mpg', 2), driver_pay_millicents_per_mile: n('pay_per_mile', 5), driver_pay_basis: 'all',
      driver_pay_percent_bp: n('pay_percent', 2), maintenance_millicents_per_mile: n('maintenance', 5), tolls_cents: n('tolls', 2),
      fixed_monthly_cents: n('fixed_monthly', 2), miles_per_month: n('miles_per_month', 0), target_margin_bp: n('target_margin', 2),
    };
    if (Object.values(values).some((v) => v === null)) return setError('Check the numbers — one of them could not be read');
    try {
      setResult(await api('/rate-calculator', { method: 'POST', body: values }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Rate calculator" />
      <div className="card space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          {FIELDS.map((f) => (
            <Field key={f.key} label={f.label}>
              <input className="input" inputMode="decimal" value={form[f.key] ?? ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
            </Field>
          ))}
        </div>
        {Object.keys(basis).length > 0 && <p className="text-xs text-slate-500">Prefilled from your last 90 days: {Object.values(basis).join('; ')}.</p>}
        <ErrorText error={error} />
        <button className="btn" onClick={() => void calc()}>Calculate</button>
      </div>
      {result && (
        <div className="grid gap-4 md:grid-cols-2">
          <section className="card text-sm">
            <h2 className="mb-2 font-medium">Trip cost ({result.total_miles} mi)</h2>
            <dl className="grid grid-cols-2 gap-y-1">
              {Object.entries(result.costs as Record<string, number>).map(([k, v]) => <Fragment key={k}><dt className="text-slate-500">{k.replace('_cents', '').replace('_', ' ')}</dt><dd className="text-right tabular-nums">{formatCents(v)}</dd></Fragment>)}
              <dt className="font-medium">Total cost</dt><dd className="text-right font-medium tabular-nums">{formatCents(result.total_cost_cents)}</dd>
            </dl>
          </section>
          <section className="card text-sm">
            <h2 className="mb-2 font-medium">Verdict</h2>
            <p className={`text-2xl font-semibold ${result.profit_cents < 0 ? 'text-red-700' : 'text-green-800'}`}>{formatCents(result.profit_cents)} {result.margin_bp !== null && <span className="text-base">({formatScaled(Math.abs(result.margin_bp), 2)}%{result.margin_bp < 0 ? ' loss' : ' margin'})</span>}</p>
            <dl className="mt-2 grid grid-cols-2 gap-y-1">
              <dt className="text-slate-500">Rate per total mile</dt><dd className="text-right">{formatCents(result.rate_per_total_mile_cents)}</dd>
              <dt className="text-slate-500">Rate per loaded mile</dt><dd className="text-right">{result.rate_per_loaded_mile_cents === null ? '—' : formatCents(result.rate_per_loaded_mile_cents)}</dd>
              <dt className="text-slate-500">All-in cost per mile</dt><dd className="text-right">{formatCents(result.cost_per_mile_cents)}</dd>
              <dt className="text-slate-500">Break-even rate</dt><dd className="text-right">{result.break_even_rate_cents === null ? '—' : formatCents(result.break_even_rate_cents)}</dd>
              <dt className="text-slate-500">Rate for target margin</dt><dd className="text-right font-medium">{result.suggested_rate_cents === null ? '—' : formatCents(result.suggested_rate_cents)}</dd>
            </dl>
          </section>
        </div>
      )}
    </div>
  );
}
