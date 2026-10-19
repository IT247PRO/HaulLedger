import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatCents } from '../api';
import { Badge, ErrorText, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks';

export function CustomerProfile() {
  const { id } = useParams();
  const { data, error, reload } = useApi<any>(`/crm/customers/${id}`);
  const [noteError, setNoteError] = useState<string | null>(null);
  if (error) return <ErrorText error={error} />;
  if (!data) return <Loading />;
  const { customer, stats } = data;

  async function addContact(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    await api(`/crm/customers/${id}/contacts`, { method: 'POST', body: { name: f.get('name'), role: f.get('role') || null, email: f.get('email') || null, phone: f.get('phone') || null } }).catch((err: Error) => setNoteError(err.message));
    form.reset();
    reload();
  }
  async function addNote(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    await api(`/crm/customers/${id}/notes`, { method: 'POST', body: { body: new FormData(form).get('body') } }).catch((err: Error) => setNoteError(err.message));
    form.reset();
    reload();
  }

  return (
    <div className="space-y-4">
      <PageHeader title={customer.name}><span className="text-sm text-slate-500">{customer.kind}{customer.mc_number && ` · ${customer.mc_number}`}</span></PageHeader>
      <div className="grid gap-4 sm:grid-cols-5">
        {[
          ['Loads', String(stats.loads)],
          ['Revenue', formatCents(stats.gross_cents)],
          ['Rate / loaded mi', stats.rate_per_loaded_mile_cents === null ? '—' : formatCents(stats.rate_per_loaded_mile_cents)],
          ['Avg days to pay', stats.avg_days_to_pay === null ? '—' : `${stats.avg_days_to_pay} days`],
          ['Open / past due', `${formatCents(stats.open_ar_cents)} / ${formatCents(stats.past_due_cents)}`],
        ].map(([k, v]) => <div key={k} className="card"><p className="text-xs text-slate-500 uppercase">{k}</p><p className="text-lg font-semibold">{v}</p></div>)}
      </div>
      <section className="card overflow-x-auto">
        <h2 className="mb-2 font-medium">Lanes &amp; rate history</h2>
        {data.lanes.length === 0 ? <p className="text-sm text-slate-500">No loads yet.</p> : (
          <table className="table">
            <thead><tr><th>Lane</th><th className="text-right">Loads</th><th className="text-right">Avg rate</th><th className="text-right">Rate/mi</th><th className="text-right">Last rate</th><th>Last</th></tr></thead>
            <tbody>{data.lanes.map((l: any) => <tr key={l.lane}><td>{l.lane}</td><td className="text-right">{l.loads}</td><td className="text-right tabular-nums">{formatCents(l.avg_rate_cents)}</td><td className="text-right tabular-nums">{l.rate_per_mile_cents === null ? '—' : formatCents(l.rate_per_mile_cents)}</td><td className="text-right tabular-nums">{formatCents(l.last_rate_cents)}</td><td>{l.last_date}</td></tr>)}</tbody>
          </table>
        )}
      </section>
      <div className="grid gap-4 md:grid-cols-2">
        <section className="card space-y-2 text-sm">
          <h2 className="font-medium">Contacts</h2>
          <ul>{data.contacts.map((c: any) => <li key={c.id} className="flex justify-between py-1"><span>{c.name} {c.role && <span className="text-slate-500">· {c.role}</span>}</span><span className="text-slate-600">{c.phone} {c.email}</span></li>)}</ul>
          <form className="grid grid-cols-2 gap-2" onSubmit={addContact}>
            <input className="input" name="name" placeholder="Name" required /><input className="input" name="role" placeholder="Role" />
            <input className="input" name="phone" placeholder="Phone" /><input className="input" type="email" name="email" placeholder="Email" />
            <button className="btn-secondary col-span-2">Add contact</button>
          </form>
        </section>
        <section className="card space-y-2 text-sm">
          <h2 className="font-medium">Notes</h2>
          <form className="flex gap-2" onSubmit={addNote}><input className="input" name="body" placeholder="Called about Q4 lanes…" required /><button className="btn-secondary">Add</button></form>
          <ErrorText error={noteError} />
          <ul className="space-y-1">{data.notes.map((n: any) => <li key={n.id}><span className="text-slate-400">{new Date(n.created_at).toLocaleDateString()} {n.author}:</span> {n.body}</li>)}</ul>
        </section>
      </div>
      <section className="card text-sm">
        <h2 className="mb-2 font-medium">Recent loads</h2>
        <ul>{data.recent_loads.map((l: any) => <li key={l.id} className="flex items-center gap-2 py-0.5"><Link className="text-blue-700" to={`/loads/${l.id}`}>{l.load_number}</Link> {l.origin} → {l.destination} · {formatCents(l.gross_cents)} <Badge value={l.status} /></li>)}</ul>
      </section>
    </div>
  );
}
