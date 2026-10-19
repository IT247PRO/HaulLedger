import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, formatCents } from '../api';
import { useAuth } from '../auth';
import { Badge, ErrorText, Field, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks';

const lastWeek = () => {
  const end = new Date();
  const start = new Date(Date.now() - 6 * 86_400_000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
};

export function Settlements() {
  const { me } = useAuth();
  const isOwner = me?.role === 'owner';
  const { data, error } = useApi<{ settlements: any[] }>('/settlements');
  return (
    <div className="space-y-4">
      <PageHeader title={isOwner ? 'Settlements' : 'My settlements'} />
      {isOwner && <GenerateForm />}
      <ErrorText error={error} />
      <div className="card overflow-x-auto">
        {!data ? <Loading /> : data.settlements.length === 0 ? (
          <p className="text-sm text-slate-500">{isOwner ? 'No settlements yet.' : 'No settlements have been issued to you yet.'}</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Settlement</th>{isOwner && <th>Driver</th>}<th>Period</th><th>Status</th><th className="text-right">Load pay</th><th className="text-right">Deductions</th><th className="text-right">Net</th></tr>
            </thead>
            <tbody>
              {data.settlements.map((s) => (
                <tr key={s.id}>
                  <td><Link className="font-medium text-blue-700" to={`/settlements/${s.id}`}>{s.settlement_number}</Link></td>
                  {isOwner && <td>{s.driver_name} <span className="text-xs text-slate-500">{s.pay_track === 'w2' ? 'W-2' : '1099'}</span></td>}
                  <td>{s.period_start} – {s.period_end}</td>
                  <td><Badge value={s.status} /></td>
                  <td className="text-right tabular-nums">{formatCents(s.load_pay_cents + s.per_diem_cents)}</td>
                  <td className="text-right tabular-nums">{formatCents(s.advance_cents + s.deduction_cents + s.escrow_cents)}</td>
                  <td className="text-right font-medium tabular-nums">{formatCents(s.net_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function GenerateForm() {
  const navigate = useNavigate();
  const drivers = useApi<{ drivers: any[] }>('/drivers');
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const range = lastWeek();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const res = await api<{ settlement: { id: string }; warnings: string[] }>('/settlements', {
        method: 'POST',
        body: { driver_id: f.get('driver_id'), period_start: f.get('period_start'), period_end: f.get('period_end'), require_pod: f.get('require_pod') === 'on' },
      });
      if (res.warnings.length) sessionStorage.setItem(`warnings:${res.settlement.id}`, JSON.stringify(res.warnings));
      navigate(`/settlements/${res.settlement.id}`);
    } catch (err) {
      setError((err as Error).message);
      setWarnings([]);
    }
  }

  return (
    <form className="card space-y-3" onSubmit={submit}>
      <h2 className="font-medium">Run a settlement</h2>
      <p className="text-sm text-slate-500">
        Pulls every delivered, unpaid load up to the period end, plus advances, deductions, approved reimbursements and escrow. You review the draft before it is published to the driver.
      </p>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Driver">
          <select className="input" name="driver_id" required>
            <option value="">Choose…</option>
            {drivers.data?.drivers.map((d) => <option key={d.id} value={d.id}>{d.first_name} {d.last_name} ({d.pay_track === 'w2' ? 'W-2' : '1099'})</option>)}
          </select>
        </Field>
        <Field label="Period start"><input className="input" type="date" name="period_start" defaultValue={range.start} required /></Field>
        <Field label="Period end"><input className="input" type="date" name="period_end" defaultValue={range.end} required /></Field>
        <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" name="require_pod" defaultChecked /> Only pay loads with a POD on file</label>
      </div>
      <ErrorText error={error} />
      {warnings.length > 0 && <ul className="text-sm text-amber-700">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
      <button className="btn">Create draft</button>
    </form>
  );
}
