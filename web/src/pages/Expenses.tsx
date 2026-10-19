import { useState, type FormEvent } from 'react';
import { api, formatCents, label, parseDollars } from '../api';
import { ErrorText, Field, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks';
import { useReferenceData } from './Loads';

const CATEGORIES = ['maintenance', 'tires', 'tolls', 'insurance', 'truck_payment', 'trailer_payment', 'permits_licenses', 'parking', 'lumper', 'factoring_fees', 'office', 'software', 'other'];

export function Expenses() {
  const { data, error, reload } = useApi<{ expenses: any[] }>('/expenses');
  const ref = useReferenceData();
  const [formError, setFormError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const amount = parseDollars(String(f.get('amount') ?? ''));
    if (!amount) return setFormError('Enter an amount like 412.00');
    const get = (k: string) => String(f.get(k) ?? '').trim() || null;
    try {
      await api('/expenses', {
        method: 'POST',
        body: { amount_cents: amount, category: get('category'), incurred_on: get('incurred_on'), vendor: get('vendor'), description: get('description'), truck_id: get('truck_id'), trailer_id: get('trailer_id') },
      });
      form.reset();
      setFormError(null);
      reload();
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Expenses" />
      <form className="card space-y-3" onSubmit={submit}>
        <p className="text-sm text-slate-500">Tie costs to a truck so per-truck P&amp;L is true. Fuel comes from the fuel-card import, not here.</p>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Amount $"><input className="input" name="amount" inputMode="decimal" required /></Field>
          <Field label="Category"><select className="input" name="category">{CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Field>
          <Field label="Date"><input className="input" type="date" name="incurred_on" defaultValue={new Date().toISOString().slice(0, 10)} required /></Field>
          <Field label="Vendor"><input className="input" name="vendor" /></Field>
          <Field label="Description"><input className="input" name="description" required /></Field>
          <Field label="Truck"><select className="input" name="truck_id"><option value="">Company overhead</option>{ref.trucks.map((t) => <option key={t.id} value={t.id}>{t.unit_number}</option>)}</select></Field>
          <Field label="Trailer"><select className="input" name="trailer_id"><option value="">—</option>{ref.trailers.map((t) => <option key={t.id} value={t.id}>{t.unit_number}</option>)}</select></Field>
          <div className="flex items-end"><button className="btn">Add expense</button></div>
        </div>
        <ErrorText error={formError} />
      </form>
      <ErrorText error={error} />
      <div className="card overflow-x-auto">
        {!data ? <Loading /> : (
          <table className="table">
            <thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Vendor</th><th>Unit</th><th className="text-right">Amount</th><th /></tr></thead>
            <tbody>
              {data.expenses.map((x) => (
                <tr key={x.id}>
                  <td>{x.incurred_on}</td><td>{label(x.category)}</td><td>{x.description}</td><td>{x.vendor ?? '—'}</td>
                  <td>{x.truck_unit ? `Truck ${x.truck_unit}` : x.trailer_unit ? `Trailer ${x.trailer_unit}` : 'Overhead'}</td>
                  <td className="text-right tabular-nums">{formatCents(x.amount_cents)}</td>
                  <td className="text-right"><button className="text-red-700" onClick={() => confirm('Delete this expense?') && void api(`/expenses/${x.id}`, { method: 'DELETE' }).then(reload)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
