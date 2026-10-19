import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, DOC_KIND_LABEL, formatCents, label, parseDollars } from '../api';
import { Badge, ErrorText, Field, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks';

export function Billing() {
  const navigate = useNavigate();
  const unbilled = useApi<{ loads: any[] }>('/invoices/unbilled');
  const list = useApi<{ invoices: any[] }>('/invoices');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => {
    const m = new Map<string, { name: string; loads: any[] }>();
    for (const l of unbilled.data?.loads ?? []) {
      const key = l.customer_id ?? 'none';
      if (!m.has(key)) m.set(key, { name: l.customer_name ?? 'No customer on load', loads: [] });
      m.get(key)!.loads.push(l);
    }
    return [...m.entries()];
  }, [unbilled.data]);

  async function invoice(customerId: string, loads: any[]) {
    const ids = loads.filter((l) => selected.has(l.id)).map((l) => l.id);
    if (!ids.length) return setError('Tick the loads to bill');
    try {
      const res = await api<{ invoice: { id: string }; warnings: string[] }>('/invoices', { method: 'POST', body: { customer_id: customerId, load_ids: ids } });
      if (res.warnings.length) alert(res.warnings.join('\n'));
      navigate(`/invoices/${res.invoice.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Billing" />
      <section className="card space-y-4">
        <div>
          <h2 className="font-medium">Ready to bill</h2>
          <p className="text-sm text-slate-500">Delivered loads not yet invoiced. Bill as soon as the POD is in — that is when cash starts moving.</p>
        </div>
        <ErrorText error={error ?? unbilled.error} />
        {!unbilled.data ? <Loading /> : groups.length === 0 ? <p className="text-sm text-slate-500">Everything delivered has been billed.</p> : groups.map(([customerId, g]) => (
          <div key={customerId} className="rounded-md border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
              <p className="font-medium">{g.name}</p>
              {customerId !== 'none' ? <button className="btn" onClick={() => void invoice(customerId, g.loads)}>Invoice selected</button> : <span className="text-xs text-amber-700">Set a customer on these loads to bill them</span>}
            </div>
            <table className="table">
              <tbody>
                {g.loads.map((l) => (
                  <tr key={l.id}>
                    <td className="w-8">
                      <input type="checkbox" disabled={customerId === 'none'} checked={selected.has(l.id)}
                        onChange={(e) => setSelected((s) => { const n = new Set(s); e.target.checked ? n.add(l.id) : n.delete(l.id); return n; })} />
                    </td>
                    <td><Link className="text-blue-700" to={`/loads/${l.id}`}>{l.load_number}</Link></td>
                    <td>{l.origin} → {l.destination}</td>
                    <td>{new Date(l.delivered_at).toLocaleDateString()}</td>
                    <td>{l.pod_received_at ? <span className="text-green-700">POD ✓</span> : <span className="text-amber-700">No POD</span>}</td>
                    <td className="text-right tabular-nums">{formatCents(l.gross_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      <section className="card overflow-x-auto">
        <h2 className="mb-2 font-medium">Invoices</h2>
        {!list.data ? <Loading /> : (
          <table className="table">
            <thead><tr><th>Invoice</th><th>Customer</th><th>Issued</th><th>Due</th><th>Status</th><th className="text-right">Total</th><th className="text-right">Balance</th></tr></thead>
            <tbody>
              {list.data.invoices.map((i) => (
                <tr key={i.id}>
                  <td><Link className="font-medium text-blue-700" to={`/invoices/${i.id}`}>{i.invoice_number}</Link></td>
                  <td>{i.customer_name}</td>
                  <td>{i.issued_on}</td>
                  <td className={i.status === 'open' && i.due_on < new Date().toISOString().slice(0, 10) ? 'text-red-700' : ''}>{i.due_on}</td>
                  <td><Badge value={i.status} /></td>
                  <td className="text-right tabular-nums">{formatCents(i.total_cents)}</td>
                  <td className="text-right tabular-nums">{formatCents(i.balance_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

export function InvoiceView() {
  const { id } = useParams();
  const { data, error, reload } = useApi<{ invoice: any }>(`/invoices/${id}`);
  const [payError, setPayError] = useState<string | null>(null);
  if (error) return <ErrorText error={error} />;
  if (!data) return <Loading />;
  const inv = data.invoice;

  async function pay(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const amount = parseDollars(String(f.get('amount') ?? ''));
    if (!amount) return setPayError('Enter an amount like 1500.00');
    try {
      await api(`/invoices/${id}/payments`, { method: 'POST', body: { amount_cents: amount, received_on: f.get('received_on'), method: f.get('method'), reference: f.get('reference') || null } });
      setPayError(null);
      reload();
    } catch (err) {
      setPayError((err as Error).message);
    }
  }
  const act = (path: string) => api(`/invoices/${id}${path}`, { method: 'POST' }).then(reload).catch((e: Error) => setPayError(e.message));

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap gap-2 print:hidden">
        <button className="btn-secondary" onClick={() => window.print()}>Print / PDF</button>
        {!inv.sent_at && inv.status === 'open' && <button className="btn-secondary" onClick={() => void act('/mark-sent')}>Mark sent</button>}
        {inv.status === 'open' && inv.paid_cents === 0 && <button className="btn-secondary" onClick={() => confirm('Void this invoice? Its loads go back to the billing queue.') && void act('/void')}>Void</button>}
      </div>
      <div className="card space-y-4 print:border-0 print:shadow-none">
        <header className="flex justify-between gap-4">
          <div>
            <p className="text-lg font-semibold">{inv.carrier_name}</p>
            <p className="mt-3 text-sm text-slate-500">Bill to</p>
            <p className="font-medium">{inv.customer_name}</p>
            {inv.customer_mc && <p className="text-sm">{inv.customer_mc}</p>}
            {inv.billing_address && <p className="text-sm whitespace-pre-line">{inv.billing_address}</p>}
          </div>
          <div className="text-right">
            <h1 className="text-xl font-semibold">Invoice {inv.invoice_number}</h1>
            <Badge value={inv.status} />
            <p className="mt-2 text-sm">Issued {inv.issued_on}</p>
            <p className="text-sm">Due {inv.due_on} (net {inv.terms_days})</p>
          </div>
        </header>
        <table className="table">
          <thead><tr><th>Description</th><th className="text-right">Amount</th></tr></thead>
          <tbody>
            {inv.lines.map((l: any) => <tr key={l.id}><td>{l.description}</td><td className="text-right tabular-nums">{formatCents(l.amount_cents)}</td></tr>)}
            <tr><td className="font-medium">Total</td><td className="text-right font-semibold tabular-nums">{formatCents(inv.total_cents)}</td></tr>
            {inv.paid_cents > 0 && <tr><td>Paid</td><td className="text-right tabular-nums">−{formatCents(inv.paid_cents)}</td></tr>}
            <tr><td className="font-medium">Balance due</td><td className="text-right font-semibold tabular-nums">{formatCents(inv.balance_cents)}</td></tr>
          </tbody>
        </table>
        {inv.notes && <p className="text-sm">{inv.notes}</p>}
      </div>

      <section className="card text-sm print:hidden">
        <h2 className="mb-2 font-medium">Billing packet</h2>
        {inv.documents.length === 0 ? <p className="text-amber-700">No paperwork attached to these loads.</p> : (
          <ul className="flex flex-wrap gap-2">
            {inv.documents.map((d: any) => (
              <li key={d.id}><a className="rounded border border-slate-200 px-2 py-1 text-blue-700" href={`/api/documents/${d.id}/file`} target="_blank" rel="noreferrer">
                {inv.lines.find((l: any) => l.load_id === d.load_id)?.load_number} {DOC_KIND_LABEL[d.kind]}
              </a></li>
            ))}
          </ul>
        )}
      </section>

      <Factoring invoice={inv} onChange={reload} />

      <section className="card space-y-2 text-sm print:hidden">
        <h2 className="font-medium">Payments</h2>
        {inv.payments.map((p: any) => <p key={p.id}>{p.received_on} · {label(p.method)} {p.reference ?? ''} · {formatCents(p.amount_cents)}</p>)}
        {inv.status === 'open' && (
          <form className="flex flex-wrap items-end gap-2" onSubmit={pay}>
            <Field label="Amount $"><input className="input w-32" name="amount" defaultValue={(inv.balance_cents / 100).toFixed(2)} /></Field>
            <Field label="Received"><input className="input" type="date" name="received_on" defaultValue={new Date().toISOString().slice(0, 10)} /></Field>
            <Field label="Method"><select className="input" name="method">{['ach', 'check', 'wire', 'card', 'factor', 'other'].map((m) => <option key={m} value={m}>{label(m)}</option>)}</select></Field>
            <Field label="Reference"><input className="input" name="reference" /></Field>
            <button className="btn">Record payment</button>
          </form>
        )}
        <ErrorText error={payError} />
      </section>
    </div>
  );
}

function Factoring({ invoice, onChange }: { invoice: any; onChange: () => void }) {
  const companies = useApi<{ companies: any[] }>('/factoring/companies');
  const subs = useApi<{ submissions: any[] }>('/factoring/submissions');
  const [msg, setMsg] = useState<string | null>(null);
  const mine = subs.data?.submissions.filter((s) => s.invoice_id === invoice.id) ?? [];
  const live = mine.find((s) => s.status !== 'rejected');
  async function submit(factorId: string) {
    try {
      const r = await api<{ sent_to: string; attachments: number }>('/factoring/submit', { method: 'POST', body: { invoice_id: invoice.id, factor_id: factorId } });
      setMsg(`Sent to ${r.sent_to} with ${r.attachments} documents`);
      subs.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  async function funded(id: string) {
    try {
      await api(`/factoring/submissions/${id}/funded`, { method: 'POST', body: { funded_on: new Date().toISOString().slice(0, 10) } });
      subs.reload();
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  if (!companies.data || (companies.data.companies.length === 0 && !live)) return null;
  return (
    <section className="card space-y-2 text-sm print:hidden">
      <h2 className="font-medium">Factoring</h2>
      {live ? (
        <p>
          {live.status === 'submitted' ? 'Submitted' : 'Funded'} to {live.factor_name} {new Date(live.submitted_at).toLocaleDateString()}
          {live.status === 'funded' && ` · ${formatCents(live.funded_cents)} funded, ${formatCents(live.fee_cents)} fee`}
          {live.status === 'submitted' && <button className="btn ml-3" onClick={() => void funded(live.id)}>Mark funded</button>}
        </p>
      ) : invoice.status === 'open' && invoice.paid_cents === 0 ? (
        <div className="flex flex-wrap gap-2">{companies.data.companies.map((f) => <button key={f.id} className="btn-secondary" onClick={() => void submit(f.id)}>Submit to {f.name}</button>)}</div>
      ) : null}
      {msg && <p>{msg}</p>}
    </section>
  );
}
