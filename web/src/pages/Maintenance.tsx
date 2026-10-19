import { useState, type FormEvent } from 'react';
import { api, formatCents, label, parseDollars } from '../api';
import { ErrorText, Field, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks';
import { useReferenceData } from './Loads';

const PM_CLASS: Record<string, string> = { overdue: 'text-red-700 font-medium', due_soon: 'text-amber-700', no_baseline: 'text-slate-500', ok: 'text-green-700' };
const PM_TEXT: Record<string, string> = { overdue: 'Overdue', due_soon: 'Due soon', no_baseline: 'Needs a starting point', ok: 'OK' };

export function Maintenance() {
  const schedules = useApi<{ schedules: any[] }>('/maintenance/schedules');
  const open = useApi<{ dvirs: any[] }>('/dvirs?status=defects_open');
  const records = useApi<{ records: any[] }>('/maintenance/records');
  const reloadAll = () => { schedules.reload(); open.reload(); records.reload(); };

  return (
    <div className="space-y-6">
      <PageHeader title="Maintenance" />

      <section className="card space-y-3">
        <h2 className="font-medium">Open DVIR defects</h2>
        <p className="text-sm text-slate-500">A unit with an open defect cannot be dispatched until the repair is certified (49 CFR 396.11).</p>
        {!open.data ? <Loading /> : open.data.dvirs.length === 0 ? <p className="text-sm text-green-700">No open defects.</p> : open.data.dvirs.map((v) => <Certify key={v.id} dvir={v} onDone={reloadAll} />)}
      </section>

      <section className="card space-y-3 overflow-x-auto">
        <h2 className="font-medium">Preventive maintenance</h2>
        {!schedules.data ? <Loading /> : (
          <table className="table">
            <thead><tr><th>Unit</th><th>Service</th><th>Interval</th><th>Last done</th><th>Next due</th><th>Status</th></tr></thead>
            <tbody>
              {schedules.data.schedules.map((s) => (
                <tr key={s.id}>
                  <td>{s.truck_unit ? `Truck ${s.truck_unit}` : `Trailer ${s.trailer_unit}`}</td>
                  <td>{s.name}</td>
                  <td>{[s.interval_miles && `${s.interval_miles.toLocaleString()} mi`, s.interval_days && `${s.interval_days} days`].filter(Boolean).join(' / ')}</td>
                  <td>{s.last_done_on ?? '—'}{s.last_done_odometer !== null && ` @ ${s.last_done_odometer.toLocaleString()}`}</td>
                  <td>{[s.next_due_odometer && `${s.next_due_odometer.toLocaleString()} mi${s.miles_remaining !== null ? ` (${s.miles_remaining.toLocaleString()} to go)` : ''}`, s.next_due_on].filter(Boolean).join(' / ') || '—'}</td>
                  <td className={PM_CLASS[s.status]}>{PM_TEXT[s.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <ScheduleForm onDone={schedules.reload} />
      </section>

      <section className="card space-y-3 overflow-x-auto">
        <h2 className="font-medium">Repair &amp; service history</h2>
        <RecordForm schedules={schedules.data?.schedules ?? []} onDone={reloadAll} />
        {!records.data ? <Loading /> : (
          <table className="table">
            <thead><tr><th>Date</th><th>Unit</th><th>Work</th><th>Odometer</th><th>Vendor</th><th className="text-right">Cost</th></tr></thead>
            <tbody>
              {records.data.records.map((r) => (
                <tr key={r.id}>
                  <td>{r.performed_on}</td><td>{r.truck_unit ? `Truck ${r.truck_unit}` : `Trailer ${r.trailer_unit}`}</td>
                  <td>{r.description}{r.pm_name && <span className="ml-1 text-xs text-slate-500">({r.pm_name})</span>}</td>
                  <td>{r.odometer?.toLocaleString() ?? '—'}</td><td>{r.vendor ?? '—'}</td><td className="text-right tabular-nums">{formatCents(r.cost_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Certify({ dvir, onDone }: { dvir: any; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api(`/dvirs/${dvir.id}/certify`, { method: 'POST', body: { result: f.get('result'), certified_name: f.get('certified_name'), notes: f.get('notes') || null } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <div className="rounded-md border border-red-200 p-3 text-sm">
      <p className="font-medium">Truck {dvir.truck_unit}{dvir.trailer_unit && ` / trailer ${dvir.trailer_unit}`} — {label(dvir.kind)} by {dvir.driver_name}, {new Date(dvir.inspected_at).toLocaleString()}</p>
      <ul className="my-1 list-disc pl-5">
        {dvir.defects.map((d: any) => <li key={d.id}>{label(d.unit)}: {label(d.component)} — {d.description}{d.out_of_service && <strong className="text-red-700"> (out of service)</strong>}</li>)}
      </ul>
      <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
        <Field label="Result"><select className="input" name="result"><option value="repaired">Defects repaired</option><option value="no_repair_needed">Repair not necessary for safe operation</option></select></Field>
        <Field label="Certified by (name)"><input className="input" name="certified_name" required /></Field>
        <Field label="Notes"><input className="input" name="notes" /></Field>
        <button className="btn">Certify</button>
      </form>
      <ErrorText error={error} />
    </div>
  );
}

function ScheduleForm({ onDone }: { onDone: () => void }) {
  const ref = useReferenceData();
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const [kind, unitId] = String(f.get('unit')).split(':');
    const num = (k: string) => (f.get(k) ? Number(f.get(k)) : null);
    try {
      await api('/maintenance/schedules', {
        method: 'POST',
        body: { truck_id: kind === 'truck' ? unitId : null, trailer_id: kind === 'trailer' ? unitId : null, name: f.get('name'), interval_miles: num('interval_miles'), interval_days: num('interval_days'), last_done_on: f.get('last_done_on') || null, last_done_odometer: num('last_done_odometer') },
      });
      form.reset();
      setError(null);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <form className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3" onSubmit={submit}>
      <Field label="Unit"><select className="input" name="unit">{ref.trucks.map((t) => <option key={t.id} value={`truck:${t.id}`}>Truck {t.unit_number}</option>)}{ref.trailers.map((t) => <option key={t.id} value={`trailer:${t.id}`}>Trailer {t.unit_number}</option>)}</select></Field>
      <Field label="Service"><input className="input" name="name" placeholder="Oil & filter" required /></Field>
      <Field label="Every (miles)"><input className="input w-28" type="number" name="interval_miles" /></Field>
      <Field label="Every (days)"><input className="input w-24" type="number" name="interval_days" /></Field>
      <Field label="Last done"><input className="input" type="date" name="last_done_on" /></Field>
      <Field label="At odometer"><input className="input w-28" type="number" name="last_done_odometer" /></Field>
      <button className="btn-secondary">Add schedule</button>
      <div className="w-full"><ErrorText error={error} /></div>
    </form>
  );
}

function RecordForm({ schedules, onDone }: { schedules: any[]; onDone: () => void }) {
  const ref = useReferenceData();
  const [unit, setUnit] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const [kind, unitId] = unit.split(':');
    const cost = f.get('cost') ? parseDollars(String(f.get('cost'))) : 0;
    if (cost === null) return setError('Cost must look like 389.50');
    try {
      await api('/maintenance/records', {
        method: 'POST',
        body: {
          truck_id: kind === 'truck' ? unitId : null, trailer_id: kind === 'trailer' ? unitId : null, performed_on: f.get('performed_on'),
          odometer: f.get('odometer') ? Number(f.get('odometer')) : null, vendor: f.get('vendor') || null, description: f.get('description'),
          cost_cents: cost, pm_schedule_id: f.get('pm_schedule_id') || null,
        },
      });
      form.reset();
      setError(null);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  const [kind, unitId] = unit.split(':');
  const unitSchedules = schedules.filter((s) => (kind === 'truck' ? s.truck_id : s.trailer_id) === unitId);
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
      <Field label="Unit"><select className="input" value={unit} onChange={(e) => setUnit(e.target.value)} required><option value="">Choose…</option>{ref.trucks.map((t) => <option key={t.id} value={`truck:${t.id}`}>Truck {t.unit_number}</option>)}{ref.trailers.map((t) => <option key={t.id} value={`trailer:${t.id}`}>Trailer {t.unit_number}</option>)}</select></Field>
      <Field label="Date"><input className="input" type="date" name="performed_on" required defaultValue={new Date().toISOString().slice(0, 10)} /></Field>
      <Field label="Work done"><input className="input" name="description" required /></Field>
      <Field label="Odometer"><input className="input w-28" type="number" name="odometer" /></Field>
      <Field label="Vendor"><input className="input" name="vendor" /></Field>
      <Field label="Cost $"><input className="input w-28" name="cost" inputMode="decimal" /></Field>
      {unitSchedules.length > 0 && <Field label="Completes PM"><select className="input" name="pm_schedule_id"><option value="">—</option>{unitSchedules.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
      <button className="btn">Add record</button>
      <div className="w-full"><ErrorText error={error} /><p className="text-xs text-slate-500">The cost is posted to expenses for this unit, so it shows in P&amp;L.</p></div>
    </form>
  );
}
