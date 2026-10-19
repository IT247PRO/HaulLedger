import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, Field, formValues, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks';

const ROLE_LABEL = { owner: 'Owner', dispatcher: 'Dispatcher', driver: 'Driver' } as const;

export function Users() {
  const { me } = useAuth();
  const { data, error, reload } = useApi<{ users: any[] }>('/users');
  const drivers = useApi<{ drivers: any[] }>('/drivers');
  const [adding, setAdding] = useState(false);
  const [role, setRole] = useState<'dispatcher' | 'driver' | 'owner'>('dispatcher');
  const [formError, setFormError] = useState<string | null>(null);

  const taken = new Set(data?.users.map((u) => u.driver_id).filter(Boolean));
  const driverName = (id: string) => {
    const d = drivers.data?.drivers.find((x) => x.id === id);
    return d ? `${d.first_name} ${d.last_name}` : '';
  };

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      await api('/users', { method: 'POST', body: { ...formValues(e.currentTarget), role } });
      setAdding(false);
      reload();
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  async function remove(id: string) {
    if (!confirm('Remove this login? They will be signed out immediately.')) return;
    await api(`/users/${id}`, { method: 'DELETE' });
    reload();
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Team logins">
        <button className="btn" onClick={() => setAdding(true)}>Add login</button>
      </PageHeader>
      <p className="text-sm text-slate-500">Unlimited users on every plan. Drivers only ever see their own loads and pay.</p>
      {adding && (
        <form className="card space-y-3" onSubmit={submit}>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Role">
              <select className="input" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
                <option value="dispatcher">Dispatcher</option>
                <option value="driver">Driver</option>
                <option value="owner">Owner</option>
              </select>
            </Field>
            {role === 'driver' && (
              <Field label="Driver record">
                <select className="input" name="driver_id" required>
                  <option value="">Choose…</option>
                  {drivers.data?.drivers.filter((d) => !taken.has(d.id)).map((d) => (
                    <option key={d.id} value={d.id}>{d.first_name} {d.last_name}</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Name"><input className="input" name="name" required /></Field>
            <Field label="Email"><input className="input" name="email" type="email" required /></Field>
            <Field label="Temporary password (10+)"><input className="input" name="password" type="text" minLength={10} required /></Field>
          </div>
          <ErrorText error={formError} />
          <div className="flex gap-2">
            <button className="btn">Create login</button>
            <button type="button" className="btn-secondary" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </form>
      )}
      <ErrorText error={error} />
      <div className="card overflow-x-auto">
        {!data ? <Loading /> : (
          <table className="table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th /></tr></thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id}>
                  <td className="font-medium">{u.name}</td>
                  <td>{u.email}</td>
                  <td>{ROLE_LABEL[u.role as keyof typeof ROLE_LABEL]}{u.driver_id && <span className="text-slate-500"> — {driverName(u.driver_id)}</span>}</td>
                  <td className="text-right">
                    {u.id !== me?.id && <button className="btn-secondary" onClick={() => void remove(u.id)}>Remove</button>}
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
