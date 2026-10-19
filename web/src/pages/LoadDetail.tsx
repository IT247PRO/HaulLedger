import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, formatCents, STATUS_LABEL } from '../api';
import { useAuth } from '../auth';
import { Badge, ErrorText, Field, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks';
import { useReferenceData } from './Loads';

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
            {staff && (<><dt className="text-slate-500">Rate</dt><dd className="tabular-nums">{formatCents(load.rate_cents)}</dd></>)}
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

      {staff && <Assignment load={load} onSaved={reload} />}

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
