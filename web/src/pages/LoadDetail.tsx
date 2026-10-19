import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, formatCents, formatScaled, parseDollars, parseScaled, STATUS_LABEL } from '../api';
import { useAuth } from '../auth';
import { Badge, ErrorText, Field, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks';
import { useReferenceData } from './Loads';
import { DocumentLinks, DocumentUpload } from '../components/Documents';
import { StateMiles } from '../components/StateMiles';

// Mirrors the server's transition table so we only offer valid buttons; the server still decides.
const NEXT: Record<string, string[]> = {
  planned: ['dispatched', 'cancelled'],
  dispatched: ['at_pickup', 'planned', 'cancelled'],
  at_pickup: ['in_transit', 'cancelled'],
  in_transit: ['delivered'],
  delivered: [],
  cancelled: ['planned'],
};
const DRIVER_NEXT: Record<string, string> = { dispatched: 'at_pickup', at_pickup: 'in_transit', in_transit: 'delivered' };
const ACTION_LABEL: Record<string, string> = {
  dispatched: 'Dispatch',
  at_pickup: 'Arrived at pickup',
  in_transit: 'Loaded — in transit',
  delivered: 'Delivered',
  cancelled: 'Cancel load',
  planned: 'Back to planned',
};

export function LoadDetail() {
  const { id } = useParams();
  const { me } = useAuth();
  const staff = me?.role !== 'driver';
  const { data, error, reload } = useApi<{ load: any }>(`/loads/${id}`);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function move(status: string) {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/loads/${id}/status`, { method: 'POST', body: { status } });
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorText error={error} />;
  if (!data) return <Loading />;
  const load = data.load;
  const actions: string[] = staff ? NEXT[load.status] ?? [] : DRIVER_NEXT[load.status] ? [DRIVER_NEXT[load.status]!] : [];

  return (
    <div className="space-y-4">
      <PageHeader title={`Load ${load.load_number}`}>
        <Badge value={load.status} />
      </PageHeader>

      <div className="card flex flex-wrap gap-2">
        {actions.length === 0 && <p className="text-sm text-slate-500">No further steps for this load.</p>}
        {actions.map((s) => (
          <button
            key={s}
            disabled={busy}
            className={s === 'cancelled' || s === 'planned' ? 'btn-secondary' : `btn ${staff ? '' : 'w-full py-4 text-base sm:w-auto'}`}
            onClick={() => void move(s)}
          >
            {ACTION_LABEL[s]}
          </button>
        ))}
        <div className="w-full"><ErrorText error={actionError} /></div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="card text-sm">
          <h2 className="mb-2 font-medium">Details</h2>
          <dl className="grid grid-cols-2 gap-y-1">
            <dt className="text-slate-500">Customer</dt><dd>{load.customer_name ?? '—'}</dd>
            <dt className="text-slate-500">Reference</dt><dd>{load.reference_number ?? '—'}</dd>
            {staff && (
              <>
                <dt className="text-slate-500">Linehaul</dt><dd className="tabular-nums">{formatCents(load.rate_cents)}</dd>
                <dt className="text-slate-500">Fuel surcharge</dt><dd className="tabular-nums">{formatCents(load.fuel_surcharge_cents)}</dd>
                <dt className="text-slate-500">Accessorials</dt><dd className="tabular-nums">{formatCents(load.accessorial_cents)}</dd>
                <dt className="text-slate-500">Hours (hourly pay)</dt><dd>{load.pay_hours_x100 === null ? '—' : (load.pay_hours_x100 / 100).toFixed(2)}</dd>
              </>
            )}
            <dt className="text-slate-500">POD</dt>
            <dd>{load.pod_received_at ? <span className="text-green-700">Received {new Date(load.pod_received_at).toLocaleDateString()}</span> : <span className="text-amber-700">Not yet</span>}</dd>
            <dt className="text-slate-500">Loaded / empty miles</dt><dd>{load.loaded_miles ?? '—'} / {load.empty_miles ?? '—'}</dd>
            <dt className="text-slate-500">Commodity</dt><dd>{load.commodity ?? '—'}</dd>
            <dt className="text-slate-500">Weight</dt><dd>{load.weight_lbs ? `${load.weight_lbs.toLocaleString()} lbs` : '—'}</dd>
            <dt className="text-slate-500">Driver</dt><dd>{load.driver_name ?? 'Unassigned'}</dd>
            <dt className="text-slate-500">Truck / trailer</dt><dd>{load.truck_unit ?? '—'} / {load.trailer_unit ?? '—'}</dd>
          </dl>
          {load.notes && <p className="mt-3 whitespace-pre-wrap text-slate-700">{load.notes}</p>}
        </section>

        <section className="card text-sm">
          <h2 className="mb-2 font-medium">Stops</h2>
          <ol className="space-y-2">
            {load.stops.map((s: any) => (
              <li key={s.id} className="flex gap-3">
                <span className={`mt-0.5 h-5 w-5 shrink-0 rounded-full text-center text-xs leading-5 text-white ${s.kind === 'pickup' ? 'bg-blue-600' : 'bg-green-600'}`}>
                  {s.seq}
                </span>
                <div>
                  <p className="font-medium">{s.kind === 'pickup' ? 'Pickup' : 'Delivery'} — {s.city}, {s.state}</p>
                  {s.facility_name && <p className="text-slate-600">{s.facility_name}</p>}
                  {s.scheduled_start && <p className="text-slate-500">{new Date(s.scheduled_start).toLocaleString()}</p>}
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <section className="card space-y-3 text-sm">
        <h2 className="font-medium">Paperwork</h2>
        <DocumentLinks docs={load.documents} />
        <DocumentUpload
          big={!staff}
          kinds={staff ? ['pod', 'bol', 'rate_confirmation', 'lumper', 'scale', 'receipt', 'other'] : ['pod', 'bol', 'lumper', 'scale', 'receipt', 'other']}
          fields={{ load_id: load.id }}
          onUploaded={reload}
        />
      </section>

      {staff && <Assignment load={load} onSaved={reload} />}
      {staff && <Revenue load={load} onSaved={reload} />}
      {staff && load.truck_id && <StateMiles loadId={load.id} expected={(load.loaded_miles ?? 0) + (load.empty_miles ?? 0)} />}

      <section className="card text-sm">
        <h2 className="mb-2 font-medium">History</h2>
        <ul className="space-y-1">
          {load.events.map((e: any) => (
            <li key={e.id} className="text-slate-600">
              <span className="text-slate-400">{new Date(e.created_at).toLocaleString()}</span> — {STATUS_LABEL[e.to_status]}
              {e.user_name && <> by {e.user_name}</>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Assignment({ load, onSaved }: { load: any; onSaved: () => void }) {
  const ref = useReferenceData();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ driver_id: load.driver_id ?? '', truck_id: load.truck_id ?? '', trailer_id: load.trailer_id ?? '' });
  if (load.status === 'delivered') return null;

  async function save() {
    setError(null);
    try {
      await api(`/loads/${load.id}`, {
        method: 'PATCH',
        body: { driver_id: form.driver_id || null, truck_id: form.truck_id || null, trailer_id: form.trailer_id || null },
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="card">
      <h2 className="mb-2 font-medium">Assignment</h2>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Driver">
          <select className="input" value={form.driver_id} onChange={(e) => setForm({ ...form, driver_id: e.target.value })}>
            <option value="">Unassigned</option>
            {ref.drivers.map((d) => <option key={d.id} value={d.id}>{d.first_name} {d.last_name}</option>)}
          </select>
        </Field>
        <Field label="Truck">
          <select className="input" value={form.truck_id} onChange={(e) => setForm({ ...form, truck_id: e.target.value })}>
            <option value="">—</option>
            {ref.trucks.map((t) => <option key={t.id} value={t.id}>{t.unit_number}</option>)}
          </select>
        </Field>
        <Field label="Trailer">
          <select className="input" value={form.trailer_id} onChange={(e) => setForm({ ...form, trailer_id: e.target.value })}>
            <option value="">—</option>
            {ref.trailers.map((t) => <option key={t.id} value={t.id}>{t.unit_number}</option>)}
          </select>
        </Field>
        <div className="flex items-end"><button className="btn" onClick={() => void save()}>Save assignment</button></div>
      </div>
      <div className="mt-2"><ErrorText error={error} /></div>
    </section>
  );
}

function Revenue({ load, onSaved }: { load: any; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const dollars = (k: string) => parseDollars(String(f.get(k) ?? '0') || '0');
    const hours = String(f.get('hours') ?? '').trim();
    const body = {
      rate_cents: dollars('rate'),
      fuel_surcharge_cents: dollars('fsc'),
      accessorial_cents: dollars('acc'),
      pay_hours_x100: hours ? parseScaled(hours, 2) : null,
      loaded_miles: f.get('loaded') ? Number(f.get('loaded')) : null,
      empty_miles: f.get('empty') ? Number(f.get('empty')) : null,
    };
    if ([body.rate_cents, body.fuel_surcharge_cents, body.accessorial_cents].includes(null) || (hours && body.pay_hours_x100 === null)) {
      return setError('Amounts must look like 1234.56; hours like 8.25');
    }
    try {
      await api(`/loads/${load.id}`, { method: 'PATCH', body });
      setError(null);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  const d = (c: number) => formatScaled(c, 2).replace(/,/g, '');
  return (
    <form className="card" onSubmit={save}>
      <h2 className="mb-2 font-medium">Revenue &amp; pay inputs</h2>
      <div className="grid gap-3 sm:grid-cols-6">
        <Field label="Linehaul $"><input className="input" name="rate" defaultValue={d(load.rate_cents)} /></Field>
        <Field label="Fuel surcharge $"><input className="input" name="fsc" defaultValue={d(load.fuel_surcharge_cents)} /></Field>
        <Field label="Accessorials $"><input className="input" name="acc" defaultValue={d(load.accessorial_cents)} /></Field>
        <Field label="Loaded miles"><input className="input" name="loaded" type="number" min={0} defaultValue={load.loaded_miles ?? ''} /></Field>
        <Field label="Empty miles"><input className="input" name="empty" type="number" min={0} defaultValue={load.empty_miles ?? ''} /></Field>
        <Field label="Hours"><input className="input" name="hours" defaultValue={load.pay_hours_x100 === null ? '' : formatScaled(load.pay_hours_x100, 2)} /></Field>
      </div>
      <div className="mt-2 flex items-center gap-3"><button className="btn">Save</button><ErrorText error={error} /></div>
    </form>
  );
}
