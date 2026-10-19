import { useState, type FormEvent } from 'react';
import { ApiError, formatCents, formatScaled, label, api } from '../api';
import { useAuth } from '../auth';
import { ErrorText, Field, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks';
import { useReferenceData } from './Loads';

const FIELD_LABEL: Record<string, string> = { date: 'Date', state: 'State', amount: 'Amount', gallons: 'Gallons', unit: 'Unit / truck', card: 'Card number', product: 'Product' };

export function Fuel() {
  const { me } = useAuth();
  const [unmatchedOnly, setUnmatchedOnly] = useState(false);
  const txs = useApi<{ transactions: any[] }>(`/fuel/transactions${unmatchedOnly ? '?unmatched=1' : ''}`);
  const imports = useApi<{ imports: any[] }>('/fuel/imports');
  const ref = useReferenceData();
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsMapping, setNeedsMapping] = useState<{ missing: string[]; headers: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const mapping: Record<string, string> = {};
    for (const field of needsMapping?.missing ?? []) {
      const v = form.get(`map_${field}`);
      if (v) mapping[field] = String(v);
      form.delete(`map_${field}`);
    }
    if (Object.keys(mapping).length) form.set('mapping', JSON.stringify(mapping));
    form.set('charge_back', form.get('charge_back') === 'on' ? 'true' : 'false');
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/fuel/imports', { method: 'POST', credentials: 'same-origin', body: form });
      const data = await res.json();
      if (res.status === 422) {
        setNeedsMapping({ missing: data.missing, headers: data.headers });
        setError(data.error);
        return;
      }
      if (!res.ok) throw new ApiError(res.status, data.error);
      setResult(data);
      setNeedsMapping(null);
      txs.reload();
      imports.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function assign(id: string, truck_id: string) {
    await api(`/fuel/transactions/${id}`, { method: 'PATCH', body: { truck_id: truck_id || null } });
    txs.reload();
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Fuel" />
      <form className="card space-y-3" onSubmit={submit}>
        <h2 className="font-medium">Import a fuel-card export (CSV)</h2>
        <p className="text-sm text-slate-500">EFS, WEX and Comdata transaction exports. Rows are matched to truck, driver and load; importing the same file twice adds nothing.</p>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Provider"><select className="input" name="provider"><option value="efs">EFS</option><option value="wex">WEX</option><option value="comdata">Comdata</option><option value="other">Other</option></select></Field>
          <Field label="Rows with no product are"><select className="input" name="default_product"><option value="diesel">Diesel</option><option value="gasoline">Gasoline</option><option value="other">Other</option></select></Field>
          <Field label="CSV file"><input className="input" type="file" name="file" accept=".csv,text/csv" required /></Field>
          {me?.role === 'owner' && (
            <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" name="charge_back" /> Charge fuel to 1099 contractors &amp; card cash as advances</label>
          )}
        </div>
        {needsMapping && (
          <div className="grid gap-3 rounded-md bg-amber-50 p-3 sm:grid-cols-3">
            {needsMapping.missing.map((f) => (
              <Field key={f} label={`Column for ${FIELD_LABEL[f] ?? f}`}>
                <select className="input" name={`map_${f}`} required><option value="">Choose…</option>{needsMapping.headers.map((h) => <option key={h} value={h}>{h}</option>)}</select>
              </Field>
            ))}
          </div>
        )}
        <ErrorText error={error} />
        {result && (
          <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800">
            Imported {result.import.imported_count} of {result.import.row_count} rows · {result.import.duplicate_count} already imported · {result.import.unmatched_count} need a truck · {result.chargebacks} charge-backs
            {result.errors.length > 0 && <> · {result.errors.length} rows skipped: {result.errors.slice(0, 3).map((e: any) => `row ${e.row} (${e.error})`).join('; ')}</>}
          </p>
        )}
        <button className="btn" disabled={busy}>{busy ? 'Importing…' : 'Import'}</button>
      </form>

      <section className="card overflow-x-auto">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium">Transactions</h2>
          <label className="text-sm"><input type="checkbox" checked={unmatchedOnly} onChange={(e) => setUnmatchedOnly(e.target.checked)} /> Only rows without a truck</label>
        </div>
        {!txs.data ? <Loading /> : (
          <table className="table">
            <thead><tr><th>When</th><th>Where</th><th>Product</th><th className="text-right">Gallons</th><th className="text-right">Amount</th><th>Truck</th><th>Driver</th><th>Load</th><th>Charged</th></tr></thead>
            <tbody>
              {txs.data.transactions.map((t) => (
                <tr key={t.id}>
                  <td>{new Date(t.transacted_at).toLocaleString()}</td>
                  <td>{[t.merchant, t.city, t.state].filter(Boolean).join(', ')}</td>
                  <td>{label(t.product)}</td>
                  <td className="text-right tabular-nums">{formatScaled(t.gallons_milli, 3, 3)}</td>
                  <td className="text-right tabular-nums">{formatCents(t.amount_cents)}</td>
                  <td>
                    <select className="input py-1" value={t.truck_id ?? ''} onChange={(e) => void assign(t.id, e.target.value)}>
                      <option value="">{t.raw_unit ? `? "${t.raw_unit}"` : '—'}</option>
                      {ref.trucks.map((tr) => <option key={tr.id} value={tr.id}>{tr.unit_number}</option>)}
                    </select>
                  </td>
                  <td>{t.driver_name ?? <span className="text-slate-400">{t.raw_driver ?? '—'}</span>}</td>
                  <td>{t.load_number ?? '—'}</td>
                  <td>{t.charge_id ? 'Deduction' : t.advance_id ? 'Advance' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <FuelCards />
    </div>
  );
}

function FuelCards() {
  const cards = useApi<{ cards: any[] }>('/fuel/cards');
  const ref = useReferenceData();
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    try {
      await api('/fuel/cards', { method: 'POST', body: { provider: f.get('provider'), card_last4: f.get('card_last4'), driver_id: f.get('driver_id') || null, truck_id: f.get('truck_id') || null } });
      form.reset();
      setError(null);
      cards.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <section className="card space-y-3">
      <h2 className="font-medium">Fuel cards</h2>
      <p className="text-sm text-slate-500">Link a card's last four digits to a driver or truck; it is the most reliable match.</p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
        <Field label="Provider"><select className="input" name="provider"><option value="efs">EFS</option><option value="wex">WEX</option><option value="comdata">Comdata</option><option value="other">Other</option></select></Field>
        <Field label="Last 4"><input className="input w-24" name="card_last4" required pattern="\d{4,6}" /></Field>
        <Field label="Driver"><select className="input" name="driver_id"><option value="">—</option>{ref.drivers.map((d) => <option key={d.id} value={d.id}>{d.first_name} {d.last_name}</option>)}</select></Field>
        <Field label="Truck"><select className="input" name="truck_id"><option value="">—</option>{ref.trucks.map((t) => <option key={t.id} value={t.id}>{t.unit_number}</option>)}</select></Field>
        <button className="btn">Add card</button>
      </form>
      <ErrorText error={error} />
      <ul className="text-sm">
        {cards.data?.cards.map((c) => (
          <li key={c.id} className="flex items-center gap-3 py-1">
            <span>{c.provider.toUpperCase()} …{c.card_last4}</span>
            <span className="text-slate-500">{c.driver_name ?? ''} {c.truck_unit ? `Truck ${c.truck_unit}` : ''}</span>
            <button className="text-red-700" onClick={() => void api(`/fuel/cards/${c.id}`, { method: 'DELETE' }).then(cards.reload)}>Remove</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
