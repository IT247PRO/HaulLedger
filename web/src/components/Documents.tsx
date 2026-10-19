import { useState } from 'react';
import { DOC_KIND_LABEL, uploadDocument } from '../api';
import { ErrorText } from './ui';

export interface DocLite {
  id: string;
  kind: string;
  filename: string;
  created_at?: string;
}

export function DocumentLinks({ docs }: { docs: DocLite[] }) {
  if (docs.length === 0) return <span className="text-slate-400">No paperwork yet</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {docs.map((d) => (
        <a key={d.id} href={`/api/documents/${d.id}/file`} target="_blank" rel="noreferrer"
          className="rounded border border-slate-200 px-1.5 py-0.5 text-xs text-blue-700 hover:bg-blue-50 print:border-0 print:p-0 print:text-slate-700">
          {DOC_KIND_LABEL[d.kind] ?? d.kind}
        </a>
      ))}
    </span>
  );
}

/** Upload control. On a phone, `capture` opens the camera straight away. */
export function DocumentUpload({ kinds, fields, onUploaded, big }: { kinds: string[]; fields: Record<string, string>; onUploaded: () => void; big?: boolean }) {
  const [kind, setKind] = useState(kinds[0]!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await uploadDocument({ ...fields, kind }, file);
      onUploaded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select className="input w-auto" value={kind} onChange={(e) => setKind(e.target.value)}>
          {kinds.map((k) => <option key={k} value={k}>{DOC_KIND_LABEL[k]}</option>)}
        </select>
        <label className={`btn cursor-pointer ${big ? 'w-full py-4 text-base sm:w-auto' : ''} ${busy ? 'opacity-50' : ''}`}>
          {busy ? 'Uploading…' : 'Take photo / choose file'}
          <input type="file" className="hidden" accept="image/*,application/pdf" capture="environment" disabled={busy}
            onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      </div>
      <ErrorText error={error} />
    </div>
  );
}
