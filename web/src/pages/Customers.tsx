import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorText, Field, formValues, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks';

export function Customers() {
  const { data, error, reload } = useApi<{ customers: any[] }>('/customers');
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const c = editing && editing !== 'new' ? editing : {};

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    try {
      if (editing === 'new') await api('/customers', { method: 'POST', body: v });
      else await api(`/customers/${editing.id}`, { method: 'PATCH', body: v });
      setEditing(null);
      reload();
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Customers">
        <button className="btn" onClick={() => setEditing('new')}>Add customer</button>
      </PageHeader>
      {editing && (
        <form className="card space-y-3" onSubmit={submit}>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Name"><input className="input" name="name" defaultValue={c.name} required /></Field>
            <Field label="Kind">
              <select className="input" name="kind" defaultValue={c.kind ?? 'broker'}>
                <option value="broker">Broker</option>
                <option value="shipper">Shipper</option>
              </select>
            </Field>
            <Field label="MC number"><input className="input" name="mc_number" defaultValue={c.mc_number ?? ''} /></Field>
            <Field label="Email"><input className="input" name="email" type="email" defaultValue={c.email ?? ''} /></Field>
            <Field label="Phone"><input className="input" name="phone" defaultValue={c.phone ?? ''} /></Field>
            <Field label="Billing address"><input className="input" name="billing_address" defaultValue={c.billing_address ?? ''} /></Field>
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
            <thead><tr><th>Name</th><th>Kind</th><th>MC #</th><th>Contact</th><th /></tr></thead>
            <tbody>
              {data.customers.map((r) => (
                <tr key={r.id}>
                  <td className="font-medium">{r.name}</td>
                  <td className="capitalize">{r.kind}</td>
                  <td>{r.mc_number ?? '—'}</td>
                  <td>{r.email ?? r.phone ?? '—'}</td>
                  <td className="text-right"><button className="btn-secondary" onClick={() => setEditing(r)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
