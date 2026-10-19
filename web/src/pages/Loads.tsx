import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, parseDollars, STATUS_LABEL } from '../api';
import { ErrorText, Field, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks';
import { LoadTable } from './Dashboard';

export function LoadsList() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const { data, error } = useApi<{ loads: any[] }>(`/loads${status ? `?status=${status}` : ''}`);
  return (
    <div>
      <PageHeader title="Loads">
        <select className="input w-40" value={status} onChange={(e) => setParams(e.target.value ? { status: e.target.value } : {})}>
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <Link className="btn" to="/loads/new">New load</Link>
      </PageHeader>
      <ErrorText error={error} />
      <div className="card overflow-x-auto">{data ? <LoadTable loads={data.loads} /> : <Loading />}</div>
    </div>
  );
}

export interface StopDraft {
  kind: 'pickup' | 'delivery';
  facility_name: string;
  city: string;
  state: string;
  scheduled_start: string;
}

const blankStop = (kind: StopDraft['kind']): StopDraft => ({ kind, facility_name: '', city: '', state: '', scheduled_start: '' });

export function useReferenceData() {
  const drivers = useApi<{ drivers: any[] }>('/drivers?status=active');
  const trucks = useApi<{ trucks: any[] }>('/trucks');
  const trailers = useApi<{ trailers: any[] }>('/trailers');
  const customers = useApi<{ customers: any[] }>('/customers');
  return {
    drivers: drivers.data?.drivers ?? [],
    trucks: trucks.data?.trucks.filter((t) => t.status !== 'inactive') ?? [],
    trailers: trailers.data?.trailers.filter((t) => t.status !== 'inactive') ?? [],
    customers: customers.data?.customers ?? [],
  };
}

export function stopsPayload(stops: StopDraft[]) {
  return stops.map((s) => ({
    kind: s.kind,
    facility_name: s.facility_name || null,
    city: s.city,
    state: s.state,
    scheduled_start: s.scheduled_start ? new Date(s.scheduled_start).toISOString() : null,
  }));
}

export function StopsEditor({ stops, onChange }: { stops: StopDraft[]; onChange: (s: StopDraft[]) => void }) {
  const update = (i: number, patch: Partial<StopDraft>) => onChange(stops.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <div className="space-y-2">
      {stops.map((s, i) => (
        <div key={i} className="grid grid-cols-2 gap-2 rounded-md border border-slate-200 p-2 sm:grid-cols-[7rem_1fr_1fr_4rem_12rem_auto]">
          <select className="input" value={s.kind} onChange={(e) => update(i, { kind: e.target.value as StopDraft['kind'] })}>
            <option value="pickup">Pickup</option>
            <option value="delivery">Delivery</option>
          </select>
          <input className="input" placeholder="Facility" value={s.facility_name} onChange={(e) => update(i, { facility_name: e.target.value })} />
          <input className="input" placeholder="City" required value={s.city} onChange={(e) => update(i, { city: e.target.value })} />
          <input className="input" placeholder="ST" required maxLength={2} value={s.state} onChange={(e) => update(i, { state: e.target.value.toUpperCase() })} />
          <input className="input" type="datetime-local" value={s.scheduled_start} onChange={(e) => update(i, { scheduled_start: e.target.value })} />
          <button type="button" className="btn-secondary" disabled={stops.length <= 2} onClick={() => onChange(stops.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="btn-secondary" onClick={() => onChange([...stops.slice(0, -1), blankStop('delivery'), ...stops.slice(-1)])}>
        Add stop
      </button>
    </div>
  );
}

export function NewLoad() {
  const navigate = useNavigate();
  const ref = useReferenceData();
  const [stops, setStops] = useState<StopDraft[]>([blankStop('pickup'), blankStop('delivery')]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (k: string) => (String(f.get(k) ?? '').trim() || null);
    const rate = get('rate') ? parseDollars(get('rate')!) : 0;
    if (rate === null) return setError('Rate must be a dollar amount like 2450.00');
    const int = (k: string) => (get(k) ? Number(get(k)) : null);
    setSaving(true);
    try {
      const { load } = await api<{ load: { id: string } }>('/loads', {
        method: 'POST',
        body: {
          load_number: get('load_number') ?? undefined,
          reference_number: get('reference_number'),
          customer_id: get('customer_id'),
          driver_id: get('driver_id'),
          truck_id: get('truck_id'),
          trailer_id: get('trailer_id'),
          rate_cents: rate,
          loaded_miles: int('loaded_miles'),
          empty_miles: int('empty_miles'),
          commodity: get('commodity'),
          weight_lbs: int('weight_lbs'),
          notes: get('notes'),
          stops: stopsPayload(stops),
        },
      });
      navigate(`/loads/${load.id}`);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader title="New load" />
      <form className="card space-y-5" onSubmit={submit}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Load # (blank = next number)"><input className="input" name="load_number" /></Field>
          <Field label="Customer reference / PO"><input className="input" name="reference_number" /></Field>
          <Field label="Customer">
            <select className="input" name="customer_id">
              <option value="">—</option>
              {ref.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Rate (linehaul $)"><input className="input" name="rate" inputMode="decimal" placeholder="2450.00" /></Field>
          <Field label="Loaded miles"><input className="input" name="loaded_miles" type="number" min={0} /></Field>
          <Field label="Empty (deadhead) miles"><input className="input" name="empty_miles" type="number" min={0} /></Field>
          <Field label="Driver">
            <select className="input" name="driver_id">
              <option value="">Unassigned</option>
              {ref.drivers.map((d) => <option key={d.id} value={d.id}>{d.first_name} {d.last_name}</option>)}
            </select>
          </Field>
          <Field label="Truck">
            <select className="input" name="truck_id">
              <option value="">—</option>
              {ref.trucks.map((t) => <option key={t.id} value={t.id}>{t.unit_number}</option>)}
            </select>
          </Field>
          <Field label="Trailer">
            <select className="input" name="trailer_id">
              <option value="">—</option>
              {ref.trailers.map((t) => <option key={t.id} value={t.id}>{t.unit_number}</option>)}
            </select>
          </Field>
          <Field label="Commodity"><input className="input" name="commodity" /></Field>
          <Field label="Weight (lbs)"><input className="input" name="weight_lbs" type="number" min={0} /></Field>
        </div>
        <div>
          <p className="label">Stops (first is a pickup, last is a delivery)</p>
          <StopsEditor stops={stops} onChange={setStops} />
        </div>
        <Field label="Notes"><textarea className="input" name="notes" rows={2} /></Field>
        <ErrorText error={error} />
        <button className="btn" disabled={saving}>Create load</button>
      </form>
    </div>
  );
}
