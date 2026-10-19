import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Badge, ErrorText, Field, formValues, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks';

export function Equipment() {
  return (
    <div className="space-y-8">
      <UnitSection kind="trucks" />
      <UnitSection kind="trailers" />
    </div>
  );
}

function UnitSection({ kind }: { kind: 'trucks' | 'trailers' }) {
  const { data, error, reload } = useApi<Record<string, any[]>>(`/${kind}`);
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const isTruck = kind === 'trucks';
  const rows = data?.[kind] ?? [];

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v: Record<string, unknown> = formValues(e.currentTarget);
    if (v.year) v.year = Number(v.year);
    if (editing === 'new') await api(`/${kind}`, { method: 'POST', body: v });
    else await api(`/${kind}/${editing.id}`, { method: 'PATCH', body: v });
    setEditing(null);
    reload();
  }
  const [formError, setFormError] = useState<string | null>(null);
  const u = editing && editing !== 'new' ? editing : {};

  return (
    <section className="space-y-3">
      <PageHeader title={isTruck ? 'Trucks' : 'Trailers'}>
        <button className="btn" onClick={() => setEditing('new')}>Add {isTruck ? 'truck' : 'trailer'}</button>
      </PageHeader>
      {editing && (
        <form
          className="card space-y-3"
          onSubmit={(e) => submit(e).catch((err: Error) => setFormError(err.message))}
        >
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Unit #"><input className="input" name="unit_number" defaultValue={u.unit_number} required /></Field>
            {isTruck ? (
              <>
                <Field label="Make"><input className="input" name="make" defaultValue={u.make ?? ''} /></Field>
                <Field label="Model"><input className="input" name="model" defaultValue={u.model ?? ''} /></Field>
                <Field label="Year"><input className="input" name="year" type="number" defaultValue={u.year ?? ''} /></Field>
                <Field label="Traccar device ID"><input className="input" name="traccar_device_id" defaultValue={u.traccar_device_id ?? ''} /></Field>
              </>
            ) : (
              <Field label="Type">
                <select className="input" name="trailer_type" defaultValue={u.trailer_type ?? 'dry_van'}>
                  {['dry_van', 'reefer', 'flatbed', 'step_deck', 'tanker', 'other'].map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
                </select>
              </Field>
            )}
            <Field label="VIN"><input className="input" name="vin" defaultValue={u.vin ?? ''} /></Field>
            <Field label="Plate"><input className="input" name="plate" defaultValue={u.plate ?? ''} /></Field>
            <Field label="Plate state"><input className="input" name="plate_state" maxLength={2} defaultValue={u.plate_state ?? ''} /></Field>
            <Field label="Status">
              <select className="input" name="status" defaultValue={u.status ?? 'active'}>
                <option value="active">Active</option>
                <option value="shop">In shop</option>
                <option value="inactive">Inactive</option>
              </select>
            </Field>
          </div>
          <ErrorText error={formError} />
          <div className="flex gap-2">
            <button className="btn">Save</button>
            <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      )}
      <ErrorText error={error} />
      <div className="card overflow-x-auto">
        {!data ? <Loading /> : (
          <table className="table">
            <thead>
              <tr><th>Unit</th><th>{isTruck ? 'Make / model' : 'Type'}</th><th>Plate</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="font-medium">{r.unit_number}</td>
                  <td>{isTruck ? `${r.year ?? ''} ${r.make ?? ''} ${r.model ?? ''}` : r.trailer_type.replace('_', ' ')}</td>
                  <td>{r.plate_state} {r.plate}</td>
                  <td><Badge value={r.status} /></td>
                  <td className="text-right"><button className="btn-secondary" onClick={() => setEditing(r)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
