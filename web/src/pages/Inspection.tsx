import { useState, type FormEvent } from 'react';
import { api, label } from '../api';
import { useAuth } from '../auth';
import { ErrorText, Field, PageHeader } from '../components/ui';
import { useApi } from '../hooks';

const COMPONENTS = ['service_brakes', 'parking_brake', 'steering', 'lighting_reflectors', 'tires', 'horn', 'windshield_wipers', 'rear_vision_mirrors', 'coupling_devices', 'wheels_rims', 'emergency_equipment', 'other'];

/** Phone-first DVIR: pick the unit, tick what's wrong (or nothing), sign. */
export function Inspection() {
  const { me } = useAuth();
  const loads = useApi<{ loads: any[] }>('/loads');
  const active = loads.data?.loads.find((l) => ['dispatched', 'at_pickup', 'in_transit'].includes(l.status));
  const truckId = active?.truck_id ?? '';
  const last = useApi<{ dvirs: any[] }>(truckId ? `/dvirs?truck_id=${truckId}` : null);
  const mine = useApi<{ dvirs: any[] }>('/dvirs');
  const [defects, setDefects] = useState<{ unit: string; component: string; description: string; out_of_service: boolean }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const res = await api<{ dvir: any }>('/dvirs', {
        method: 'POST',
        body: {
          truck_id: truckId, trailer_id: active?.trailer_id ?? null, kind: f.get('kind'), odometer: f.get('odometer') ? Number(f.get('odometer')) : null,
          location: f.get('location') || null, remarks: f.get('remarks') || null, signature_name: f.get('signature_name'), defects: defects.filter((d) => d.description),
        },
      });
      setDone(res.dvir.status === 'satisfactory' ? 'Report filed — no defects.' : 'Report filed. Defects sent to the shop; the unit is held until repairs are certified.');
      setDefects([]);
      mine.reload();
      last.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!truckId) return <div><PageHeader title="Vehicle inspection" /><p className="card text-sm text-slate-500">No truck assigned to you right now.</p></div>;
  const previous = last.data?.dvirs[0];
  return (
    <div className="space-y-4">
      <PageHeader title={`Inspection — truck ${active.truck_unit}${active.trailer_unit ? ` / trailer ${active.trailer_unit}` : ''}`} />
      {previous && previous.driver_id !== me?.driver_id && !previous.reviewed_at && (
        <div className="card text-sm">
          <p className="font-medium">Last report on this truck ({previous.driver_name}, {new Date(previous.inspected_at).toLocaleDateString()})</p>
          <p>{previous.status === 'satisfactory' ? 'No defects.' : `${previous.defects.length} defect(s) — ${label(previous.status)}${previous.certified_name ? ` by ${previous.certified_name}` : ''}`}</p>
          <button className="btn mt-2" onClick={() => void api(`/dvirs/${previous.id}/review`, { method: 'POST' }).then(last.reload)}>I've reviewed it</button>
        </div>
      )}
      <form className="card space-y-3" onSubmit={submit}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Inspection"><select className="input" name="kind"><option value="pre_trip">Pre-trip</option><option value="post_trip">Post-trip</option></select></Field>
          <Field label="Odometer"><input className="input" type="number" name="odometer" inputMode="numeric" /></Field>
          <Field label="Location"><input className="input" name="location" /></Field>
        </div>
        <div className="space-y-2">
          <p className="label">Defects (leave empty if none)</p>
          {defects.map((d, i) => (
            <div key={i} className="grid gap-2 rounded-md border border-slate-200 p-2 sm:grid-cols-[6rem_12rem_1fr_auto]">
              <select className="input" value={d.unit} onChange={(e) => setDefects(defects.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))}><option value="truck">Truck</option>{active.trailer_id && <option value="trailer">Trailer</option>}</select>
              <select className="input" value={d.component} onChange={(e) => setDefects(defects.map((x, j) => (j === i ? { ...x, component: e.target.value } : x)))}>{COMPONENTS.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select>
              <input className="input" placeholder="What's wrong" value={d.description} onChange={(e) => setDefects(defects.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
              <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={d.out_of_service} onChange={(e) => setDefects(defects.map((x, j) => (j === i ? { ...x, out_of_service: e.target.checked } : x)))} /> Out of service</label>
            </div>
          ))}
          <button type="button" className="btn-secondary" onClick={() => setDefects([...defects, { unit: 'truck', component: 'tires', description: '', out_of_service: false }])}>+ Add defect</button>
        </div>
        <Field label="Remarks"><input className="input" name="remarks" /></Field>
        <Field label="Signature (type your full name)"><input className="input" name="signature_name" required defaultValue={me?.name} /></Field>
        <ErrorText error={error} />
        {done && <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">{done}</p>}
        <button className="btn w-full py-4 text-base sm:w-auto">{defects.length ? 'File report with defects' : 'File report — no defects'}</button>
      </form>
      <section className="card text-sm">
        <h2 className="mb-2 font-medium">My recent reports</h2>
        <ul className="space-y-1">{mine.data?.dvirs.map((v) => <li key={v.id}>{new Date(v.inspected_at).toLocaleString()} · truck {v.truck_unit} · {label(v.kind)} · {label(v.status)}</li>)}</ul>
      </section>
    </div>
  );
}
