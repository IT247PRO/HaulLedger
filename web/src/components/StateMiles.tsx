import { useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorText } from './ui';

/** Miles by state for a load (IFTA). Total should equal loaded + empty miles. */
export function StateMiles({ loadId, expected }: { loadId: string; expected: number }) {
  const [rows, setRows] = useState<{ state: string; miles: string }[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ miles: { state: string; miles: number }[] }>(`/ifta/loads/${loadId}/miles`).then((r) => setRows(r.miles.map((m) => ({ state: m.state, miles: String(m.miles) }))));
  }, [loadId]);
  const total = rows.reduce((a, r) => a + (Number(r.miles) || 0), 0);
  async function save() {
    setError(null);
    try {
      const res = await api<{ warnings: string[] }>(`/ifta/loads/${loadId}/miles`, { method: 'PUT', body: { miles: rows.filter((r) => r.state && r.miles).map((r) => ({ state: r.state.toUpperCase(), miles: Number(r.miles) })) } });
      setMsg(res.warnings[0] ?? 'Saved');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="card space-y-2 text-sm">
      <h2 className="font-medium">Miles by state (IFTA)</h2>
      <div className="flex flex-wrap gap-2">
        {rows.map((r, i) => (
          <span key={i} className="flex items-center gap-1">
            <input className="input w-14" maxLength={2} value={r.state} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, state: e.target.value.toUpperCase() } : x)))} />
            <input className="input w-20" type="number" min={1} value={r.miles} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, miles: e.target.value } : x)))} />
          </span>
        ))}
        <button className="btn-secondary" onClick={() => setRows([...rows, { state: '', miles: '' }])}>+ State</button>
      </div>
      <p className={total === expected ? 'text-slate-500' : 'text-amber-700'}>Total {total} of {expected} mi (loaded + empty)</p>
      <div className="flex items-center gap-3"><button className="btn" onClick={() => void save()}>Save state miles</button>{msg && <span>{msg}</span>}</div>
      <ErrorText error={error} />
    </section>
  );
}
