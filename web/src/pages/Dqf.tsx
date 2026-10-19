import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, uploadDocument } from '../api';
import { useAuth } from '../auth';
import { ErrorText, Field, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks';

const STATUS_CLASS: Record<string, string> = {
  complete: 'text-green-700',
  missing: 'text-red-700',
  expired: 'text-red-700 font-medium',
  expiring: 'text-amber-700',
  not_due: 'text-slate-500',
  attention: 'text-red-700',
};
const STATUS_TEXT: Record<string, string> = { complete: 'On file', missing: 'Missing', expired: 'Expired', expiring: 'Expiring', not_due: 'Not yet due', attention: 'Needs attention' };

export function DqfList() {
  const { data, error } = useApi<{ drivers: any[] }>('/dqf');
  return (
    <div className="space-y-4">
      <PageHeader title="Driver qualification files" />
      <p className="text-sm text-slate-500">Audit-ready DQ files per 49 CFR 391.51, with the Part 382 Clearinghouse queries kept alongside.</p>
      <ErrorText error={error} />
      <div className="card overflow-x-auto">
        {!data ? <Loading /> : (
          <table className="table">
            <thead><tr><th>Driver</th><th>File</th><th className="text-right">On file</th><th className="text-right">Missing</th><th className="text-right">Expired</th><th className="text-right">Expiring</th><th>Next due</th></tr></thead>
            <tbody>
              {data.drivers.map((d) => (
                <tr key={d.driver_id}>
                  <td><Link className="font-medium text-blue-700" to={`/dqf/${d.driver_id}`}>{d.driver_name}</Link></td>
                  <td className={STATUS_CLASS[d.overall]}>{d.overall === 'complete' ? 'Complete' : d.overall === 'expiring' ? 'Expiring soon' : 'Needs attention'}</td>
                  <td className="text-right">{d.complete}</td><td className="text-right">{d.missing}</td><td className="text-right">{d.expired}</td><td className="text-right">{d.expiring}</td>
                  <td>{d.next_due ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function DqfFile() {
  const { id } = useParams();
  const { me } = useAuth();
  const staff = me?.role !== 'driver';
  const { data, error, reload } = useApi<any>(`/dqf/${id}`);
  const [adding, setAdding] = useState<string | null>(null);
  if (error) return <ErrorText error={error} />;
  if (!data) return <Loading />;
  const d = data.driver;
  const groups = [['dqf', 'Driver qualification file — 391.51'], ['part382', 'Drug & alcohol Clearinghouse — Part 382']] as const;
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title={`DQ file — ${d.first_name} ${d.last_name}`}>
        <span className={STATUS_CLASS[data.overall]}>{STATUS_TEXT[data.overall] ?? data.overall}</span>
        <button className="btn-secondary print:hidden" onClick={() => window.print()}>Print for audit</button>
      </PageHeader>
      <p className="text-sm text-slate-600">CDL {d.license_state} {d.license_number ?? '—'} · expires {d.license_expires_on ?? '—'} · medical card expires {d.medical_expires_on ?? '—'}</p>
      {groups.map(([group, title]) => (
        <section key={group} className="card space-y-2">
          <h2 className="font-medium">{title}</h2>
          <ul className="divide-y divide-slate-100">
            {data.requirements.filter((r: any) => r.group === group).map((r: any) => (
              <li key={r.type} className="py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">{r.label} <span className="font-normal text-slate-500">§{r.cite}</span></p>
                    {r.latest && (
                      <p className="text-slate-500">
                        Completed {r.latest.completed_on}{r.due_on && ` · due ${r.due_on}`}
                        {r.latest.document_id && <> · <a className="text-blue-700" href={`/api/documents/${r.latest.document_id}/file`} target="_blank" rel="noreferrer">document</a></>}
                        {r.latest.notes && ` · ${r.latest.notes}`}
                      </p>
                    )}
                    {!r.latest && r.due_on && <p className="text-slate-500">First due {r.due_on}</p>}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={STATUS_CLASS[r.status]}>{STATUS_TEXT[r.status]}</span>
                    {staff && <button className="btn-secondary print:hidden" onClick={() => setAdding(adding === r.type ? null : r.type)}>Record</button>}
                  </div>
                </div>
                {adding === r.type && <RecordForm driverId={d.id} type={r.type} needsExpiry={r.recurrence === 'expires'} onDone={() => { setAdding(null); reload(); }} />}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <section className="card text-sm">
        <h2 className="mb-2 font-medium">History</h2>
        <ul className="space-y-1 text-slate-600">
          {data.history.map((h: any) => <li key={h.id}>{h.completed_on} · {data.requirements.find((r: any) => r.type === h.item_type)?.label} {h.expires_on && `(expires ${h.expires_on})`} · recorded by {h.recorded_by_name ?? '—'}</li>)}
        </ul>
        <p className="mt-3 text-xs text-slate-500">Keep the DQ file for the length of employment plus three years (391.51(c)); superseded annual reviews, MVRs and medical certificates for three years from their date (391.51(d)).</p>
      </section>
    </div>
  );
}

function RecordForm({ driverId, type, needsExpiry, onDone }: { driverId: string; type: string; needsExpiry: boolean; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      let documentId: string | null = null;
      const file = f.get('file');
      if (file instanceof File && file.size > 0) documentId = (await uploadDocument({ kind: 'dqf', driver_id: driverId }, file)).document.id;
      await api(`/dqf/${driverId}/items`, { method: 'POST', body: { item_type: type, completed_on: f.get('completed_on'), expires_on: f.get('expires_on') || null, notes: f.get('notes') || null, document_id: documentId } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <form className="mt-2 flex flex-wrap items-end gap-2 rounded-md bg-slate-50 p-2" onSubmit={submit}>
      <Field label="Completed / issued"><input className="input" type="date" name="completed_on" required defaultValue={new Date().toISOString().slice(0, 10)} /></Field>
      {needsExpiry && <Field label="Expires"><input className="input" type="date" name="expires_on" required /></Field>}
      <Field label="Document (PDF / photo)"><input className="input" type="file" name="file" accept="application/pdf,image/*" /></Field>
      <Field label="Notes"><input className="input" name="notes" /></Field>
      <button className="btn">Save</button>
      <ErrorText error={error} />
    </form>
  );
}

