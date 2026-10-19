import { useState, type FormEvent } from 'react';
import { api, formatCents, formatPayRate, label, parseDollars, uploadDocument } from '../api';
import { useAuth } from '../auth';
import { Badge, ErrorText, Field, PageHeader } from '../components/ui';
import { useApi } from '../hooks';

/** The driver's own pay: rates, escrow ledger, and receipt submission from the phone. */
export function MyPay() {
  const { me } = useAuth();
  const rates = useApi<{ pay_rates: any[] }>('/pay-rates');
  const reimbursements = useApi<{ reimbursements: any[] }>('/reimbursements');
  const driver = useApi<{ driver: any }>(me?.driver_id ? `/drivers/${me.driver_id}` : null);
  const escrow = useApi<any>(driver.data?.driver.pay_track === '1099' ? '/escrow' : null);
  const loads = useApi<{ loads: any[] }>('/loads');

  return (
    <div className="space-y-4">
      <PageHeader title="My pay" />
      <section className="card text-sm">
        <h2 className="mb-2 font-medium">How I'm paid</h2>
        {rates.data?.pay_rates.length === 0 && <p className="text-slate-500">No pay rates on file — ask your carrier.</p>}
        <ul className="space-y-1">
          {rates.data?.pay_rates.filter((r) => !r.effective_to || r.effective_to >= new Date().toISOString().slice(0, 10)).map((r) => (
            <li key={r.id}>{formatPayRate(r)} <span className="text-slate-500">since {r.effective_from}</span></li>
          ))}
        </ul>
      </section>

      <ReceiptForm loads={loads.data?.loads ?? []} onDone={reimbursements.reload} />

      <section className="card text-sm">
        <h2 className="mb-2 font-medium">My receipts</h2>
        <ul className="divide-y divide-slate-100">
          {reimbursements.data?.reimbursements.map((r) => (
            <li key={r.id} className="flex items-center justify-between py-2">
              <span>{r.incurred_on} · {label(r.category)} · {r.description}</span>
              <span className="flex items-center gap-2 tabular-nums">{formatCents(r.amount_cents)} <Badge value={r.settled ? 'paid' : r.status} /></span>
            </li>
          ))}
        </ul>
      </section>

      {escrow.data && (
        <section className="card text-sm">
          <h2 className="mb-2 font-medium">Escrow — balance {formatCents(escrow.data.balance_cents)}</h2>
          <p className="mb-2 text-slate-500">Target {formatCents(escrow.data.target_cents)}, held {formatCents(escrow.data.per_settlement_cents)} per settlement.</p>
          <table className="table">
            <thead><tr><th>Date</th><th>Entry</th><th>Amount</th><th>Balance</th></tr></thead>
            <tbody>
              {escrow.data.ledger.map((e: any) => (
                <tr key={e.id}><td>{e.occurred_on}</td><td>{label(e.kind)} {e.settlement_number ?? ''}</td><td className="tabular-nums">{formatCents(e.amount_cents)}</td><td className="tabular-nums">{formatCents(e.balance_cents)}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function ReceiptForm({ loads, onDone }: { loads: any[]; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const file = f.get('photo');
    const amount = parseDollars(String(f.get('amount') ?? ''));
    if (!amount) return setError('Enter the receipt amount, like 75.00');
    if (!(file instanceof File) || file.size === 0) return setError('Take a photo of the receipt');
    setBusy(true);
    try {
      const loadId = String(f.get('load_id') || '');
      const category = String(f.get('category'));
      const { document } = await uploadDocument({ kind: category === 'lumper' ? 'lumper' : category === 'scale' ? 'scale' : 'receipt', load_id: loadId }, file);
      await api('/reimbursements', {
        method: 'POST',
        body: { category, amount_cents: amount, incurred_on: f.get('incurred_on'), description: f.get('description'), load_id: loadId || null, document_id: document.id },
      });
      form.reset();
      setError(null);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card space-y-3" onSubmit={submit}>
      <h2 className="font-medium">Submit a receipt</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Type">
          <select className="input" name="category">{['lumper', 'scale', 'tolls', 'parking', 'repair', 'fuel', 'other'].map((c) => <option key={c} value={c}>{label(c)}</option>)}</select>
        </Field>
        <Field label="Amount $"><input className="input" name="amount" inputMode="decimal" required /></Field>
        <Field label="Date"><input className="input" type="date" name="incurred_on" defaultValue={new Date().toISOString().slice(0, 10)} required /></Field>
        <Field label="Load">
          <select className="input" name="load_id"><option value="">—</option>{loads.map((l) => <option key={l.id} value={l.id}>{l.load_number} {l.origin} → {l.destination}</option>)}</select>
        </Field>
        <Field label="What was it for?"><input className="input" name="description" required /></Field>
        <Field label="Photo of receipt"><input className="input" type="file" name="photo" accept="image/*,application/pdf" capture="environment" required /></Field>
      </div>
      <ErrorText error={error} />
      <button className="btn w-full sm:w-auto" disabled={busy}>{busy ? 'Sending…' : 'Submit for reimbursement'}</button>
    </form>
  );
}
