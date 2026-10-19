import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Badge, ErrorText, Field, formValues, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks';

const today = () => new Date().toISOString().slice(0, 10);
const soon = () => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

function ExpiryCell({ date }: { date: string | null }) {
  if (!date) return <span className="text-slate-400">—</span>;
  const cls = date < today() ? 'font-medium text-red-700' : date <= soon() ? 'text-amber-700' : '';
  return <span className={cls}>{date}</span>;
}

export function Drivers() {
  const { me } = useAuth();
  const isOwner = me?.role === 'owner';
  const { data, error, reload } = useApi<{ drivers: any[] }>('/drivers');
  const [editing, setEditing] = useState<any | 'new' | null>(null);

  return (
    <div className="space-y-4">
      <PageHeader title="Drivers">
        {isOwner && <button className="btn" onClick={() => setEditing('new')}>Add driver</button>}
      </PageHeader>
      {editing && (
        <DriverForm
          driver={editing === 'new' ? null : editing}
          isOwner={isOwner}
          onDone={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      <ErrorText error={error} />
      <div className="card overflow-x-auto">
        {!data ? <Loading /> : (
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Pay track</th><th>Status</th><th>CDL</th><th>CDL expires</th><th>Medical expires</th><th /></tr>
            </thead>
            <tbody>
              {data.drivers.map((d) => (
                <tr key={d.id}>
                  <td className="font-medium">{d.first_name} {d.last_name}<div className="text-xs text-slate-500">{d.phone}</div></td>
                  <td>{d.pay_track === 'w2' ? 'W-2 company' : '1099 contractor'}</td>
                  <td><Badge value={d.status} /></td>
                  <td>{d.license_state} {d.license_number}</td>
                  <td><ExpiryCell date={d.license_expires_on} /></td>
                  <td><ExpiryCell date={d.medical_expires_on} /></td>
                  <td className="text-right whitespace-nowrap">
                    <Link className="btn-secondary mr-2" to={`/dqf/${d.id}`}>DQ file</Link>
                    {isOwner && <Link className="btn-secondary mr-2" to={`/drivers/${d.id}/pay`}>Pay</Link>}
                    <button className="btn-secondary" onClick={() => setEditing(d)}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function DriverForm({ driver, isOwner, onDone }: { driver: any | null; isOwner: boolean; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    if (!isOwner) delete v.pay_track;
    try {
      if (driver) await api(`/drivers/${driver.id}`, { method: 'PATCH', body: v });
      else await api('/drivers', { method: 'POST', body: v });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  const d = driver ?? {};
  return (
    <form className="card space-y-3" onSubmit={submit}>
      <h2 className="font-medium">{driver ? `Edit ${d.first_name} ${d.last_name}` : 'Add driver'}</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="First name"><input className="input" name="first_name" defaultValue={d.first_name} required /></Field>
        <Field label="Last name"><input className="input" name="last_name" defaultValue={d.last_name} required /></Field>
        <Field label="Pay track">
          <select className="input" name="pay_track" defaultValue={d.pay_track ?? 'w2'} disabled={!isOwner}>
            <option value="w2">W-2 company driver</option>
            <option value="1099">1099 contractor / owner-operator</option>
          </select>
        </Field>
        <Field label="Email"><input className="input" name="email" type="email" defaultValue={d.email ?? ''} /></Field>
        <Field label="Phone"><input className="input" name="phone" defaultValue={d.phone ?? ''} /></Field>
        <Field label="Status">
          <select className="input" name="status" defaultValue={d.status ?? 'active'}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </Field>
        <Field label="CDL number"><input className="input" name="license_number" defaultValue={d.license_number ?? ''} /></Field>
        <Field label="CDL state"><input className="input" name="license_state" maxLength={2} defaultValue={d.license_state ?? ''} /></Field>
        <Field label="CDL class"><input className="input" name="license_class" defaultValue={d.license_class ?? ''} /></Field>
        <Field label="CDL expires"><input className="input" name="license_expires_on" type="date" defaultValue={d.license_expires_on ?? ''} /></Field>
        <Field label="Medical card expires"><input className="input" name="medical_expires_on" type="date" defaultValue={d.medical_expires_on ?? ''} /></Field>
        <Field label="Hired on"><input className="input" name="hired_on" type="date" defaultValue={d.hired_on ?? ''} /></Field>
        <Field label="ELD driver ID (Samsara / Motive)"><input className="input" name="eld_driver_id" defaultValue={d.eld_driver_id ?? ''} /></Field>
      </div>
      {!isOwner && <p className="text-xs text-slate-500">Only the owner can change a driver's pay track.</p>}
      <ErrorText error={error} />
      <div className="flex gap-2">
        <button className="btn">Save</button>
        <button type="button" className="btn-secondary" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
