import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, formatCents, label } from '../api';
import { useAuth } from '../auth';
import { DocumentLinks } from '../components/Documents';
import { Badge, ErrorText, Loading } from '../components/ui';
import { useApi } from '../hooks';

/**
 * The settlement sheet. Built so a driver can check every dollar: each pay line
 * shows the load, lane, miles, the math, and the paperwork behind it.
 */
export function SettlementSheet() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { me } = useAuth();
  const isOwner = me?.role === 'owner';
  const { data, error, reload } = useApi<{ settlement: any }>(`/settlements/${id}`);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const warnings: string[] = (() => {
    try {
      return JSON.parse(sessionStorage.getItem(`warnings:${id}`) ?? '[]');
    } catch {
      return [];
    }
  })();

  async function act(path: string, method = 'POST') {
    setActionError(null);
    try {
      const res = await api<any>(`/settlements/${id}${path}`, { method });
      if (method === 'DELETE') return navigate('/settlements');
      if (res?.sent_to) setNotice(`Sent to ${res.sent_to}`);
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  if (error) return <ErrorText error={error} />;
  if (!data) return <Loading />;
  const s = data.settlement;
  const lines: any[] = s.lines;
  const payLines = lines.filter((l) => l.kind === 'load_pay' || l.kind === 'per_diem');
  const byLoad = new Map<string, any[]>();
  for (const l of payLines) byLoad.set(l.load_id, [...(byLoad.get(l.load_id) ?? []), l]);
  const section = (kinds: string[]) => lines.filter((l) => kinds.includes(l.kind));

  return (
    <div className="mx-auto max-w-4xl space-y-4 print:max-w-none">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        {isOwner && s.status === 'draft' && <button className="btn" onClick={() => void act('/finalize')}>Finalize &amp; publish to driver</button>}
        {isOwner && s.status === 'draft' && <button className="btn-secondary" onClick={() => confirm('Delete this draft? Its loads and items go back to unsettled.') && void act('', 'DELETE')}>Delete draft</button>}
        {isOwner && s.status === 'finalized' && <button className="btn" onClick={() => void act('/mark-paid')}>Mark paid</button>}
        {isOwner && s.status !== 'draft' && <button className="btn-secondary" onClick={() => void act('/email')}>Email to driver</button>}
        <button className="btn-secondary" onClick={() => window.print()}>Print</button>
        {notice && <span className="text-sm text-green-700">{notice}</span>}
        <div className="w-full"><ErrorText error={actionError} /></div>
        {warnings.length > 0 && s.status === 'draft' && (
          <div className="w-full rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <p className="font-medium">Not included in this draft:</p>
            <ul className="list-disc pl-5">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
        )}
      </div>

      <div className="card space-y-5 print:border-0 print:shadow-none">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
          <div>
            <p className="text-sm text-slate-500">{s.carrier_name}</p>
            <h1 className="text-xl font-semibold">Settlement {s.settlement_number}</h1>
            <p className="text-sm">{s.driver_name} · {s.pay_track === 'w2' ? 'W-2 company driver' : '1099 contractor'}</p>
            <p className="text-sm text-slate-500">Period {s.period_start} – {s.period_end}</p>
          </div>
          <div className="text-right">
            <Badge value={s.status} />
            <p className="mt-2 text-xs text-slate-500 uppercase">Net pay</p>
            <p className={`text-3xl font-semibold tabular-nums ${s.net_cents < 0 ? 'text-red-700' : ''}`}>{formatCents(s.net_cents)}</p>
            {s.net_cents < 0 && <p className="text-xs text-red-700">Balance owed carries forward to the next settlement</p>}
          </div>
        </header>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <Sum label="Load pay" cents={s.load_pay_cents} />
          {s.pay_track === 'w2' && <Sum label="Per diem" cents={s.per_diem_cents} />}
          <Sum label="Reimbursements" cents={s.reimbursement_cents} />
          <Sum label="Advances" cents={s.advance_cents} />
          <Sum label="Deductions" cents={s.deduction_cents} />
          {s.pay_track === '1099' && <Sum label="Escrow" cents={s.escrow_cents} />}
          <Sum label="YTD gross pay" cents={s.ytd_gross_pay_cents} />
        </dl>

        <section>
          <h2 className="mb-2 font-medium">Loads</h2>
          {byLoad.size === 0 && <p className="text-sm text-slate-500">No loads on this settlement.</p>}
          <div className="space-y-3">
            {[...byLoad.entries()].map(([loadId, ls]) => {
              const load = s.loads[loadId] ?? {};
              const percent = ls.find((l) => l.pay_kind === 'percent');
              return (
                <div key={loadId} className="rounded-md border border-slate-200 p-3 text-sm break-inside-avoid">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-medium">
                      {load.load_number} <span className="font-normal text-slate-600">{load.origin} → {load.destination}</span>
                    </p>
                    <p className="text-slate-500">Delivered {load.delivered_at ? new Date(load.delivered_at).toLocaleDateString() : '—'}{load.truck_unit && ` · Truck ${load.truck_unit}`}</p>
                  </div>
                  <p className="text-slate-500">
                    {load.loaded_miles ?? '—'} loaded mi · {load.empty_miles ?? 0} empty mi · {load.stop_count} stops
                    {load.reference_number && ` · Ref ${load.reference_number}`}
                  </p>
                  {percent && load.rate_cents !== undefined && (
                    <p className="mt-1 rounded bg-slate-50 px-2 py-1 text-slate-700">
                      Rated freight bill: linehaul {formatCents(load.rate_cents)} + fuel surcharge {formatCents(load.fuel_surcharge_cents)} + accessorials {formatCents(load.accessorial_cents)} = <strong>{formatCents(percent.gross_cents)}</strong>
                    </p>
                  )}
                  <table className="mt-2 w-full">
                    <tbody>
                      {ls.map((l) => (
                        <tr key={l.id}>
                          <td className="py-0.5 text-slate-700">{l.description.replace(`${load.load_number} — `, '')}</td>
                          <td className="py-0.5 text-right tabular-nums">{formatCents(l.amount_cents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">Paperwork: <DocumentLinks docs={load.documents ?? []} /></div>
                </div>
              );
            })}
          </div>
        </section>

        <ItemSection title="Reimbursements" lines={section(['reimbursement'])} />
        <ItemSection title="Advances" lines={section(['advance'])} />
        <ItemSection title="Deductions" lines={section(['deduction'])} />
        {s.pay_track === '1099' && (
          <ItemSection
            title="Escrow"
            lines={section(['escrow_hold', 'escrow_release'])}
            footer={s.escrow_balance_cents !== null ? `Escrow balance after finalized settlements: ${formatCents(s.escrow_balance_cents)}` : undefined}
          />
        )}

        <footer className="border-t border-slate-200 pt-3 text-xs text-slate-500">
          Every line above links to the record behind it. Questions about a line? Quote the settlement number and the line.
          {s.pay_track === '1099' && ' Percentage-paid contractors are shown the rated freight bill for each load (49 CFR 376.12(g)).'}
          {s.pay_track === 'w2' && ' Gross earnings statement; tax withholding is calculated by payroll.'}
        </footer>
      </div>
    </div>
  );
}

function Sum({ label: name, cents }: { label: string; cents: number }) {
  return (
    <div>
      <dt className="text-slate-500">{name}</dt>
      <dd className="font-medium tabular-nums">{formatCents(cents)}</dd>
    </div>
  );
}

function ItemSection({ title, lines, footer }: { title: string; lines: any[]; footer?: string }) {
  if (lines.length === 0 && !footer) return null;
  return (
    <section className="text-sm">
      <h2 className="mb-1 font-medium">{title}</h2>
      {lines.length === 0 ? <p className="text-slate-500">None this period.</p> : (
        <table className="w-full">
          <tbody>
            {lines.map((l) => {
              const doc = l.charge_document_id ?? l.reimbursement_document_id;
              return (
                <tr key={l.id} className="border-b border-slate-100">
                  <td className="py-1">
                    {l.description}
                    {l.charge_category && <span className="ml-2 rounded bg-slate-100 px-1.5 text-xs text-slate-600">{label(l.charge_category)}</span>}
                    {doc && <a className="ml-2 text-xs text-blue-700" href={`/api/documents/${doc}/file`} target="_blank" rel="noreferrer">receipt</a>}
                    {l.fuel_transaction_id && <span className="ml-2 text-xs text-slate-500">fuel-card transaction</span>}
                  </td>
                  <td className="py-1 text-right tabular-nums">{formatCents(l.amount_cents)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {footer && <p className="mt-1 text-slate-500">{footer}</p>}
    </section>
  );
}

