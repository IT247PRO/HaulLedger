import { Link } from 'react-router-dom';
import { formatCents } from '../api';
import { Badge, ErrorText, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks';

interface Alert {
  driver_id: string;
  driver_name: string;
  kind: 'license' | 'medical';
  expires_on: string;
  expired: boolean;
}

export function Dashboard() {
  const alerts = useApi<{ alerts: Alert[] }>('/alerts/expirations?within_days=30');
  const loads = useApi<{ loads: any[] }>('/loads');
  const active = loads.data?.loads.filter((l) => ['dispatched', 'at_pickup', 'in_transit'].includes(l.status)) ?? [];
  const planned = loads.data?.loads.filter((l) => l.status === 'planned') ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard">
        <Link className="btn" to="/loads/new">New load</Link>
      </PageHeader>

      <section className="card">
        <h2 className="mb-3 font-medium">License &amp; medical card alerts</h2>
        <ErrorText error={alerts.error} />
        {!alerts.data ? (
          <Loading />
        ) : alerts.data.alerts.length === 0 ? (
          <p className="text-sm text-slate-500">No CDLs or medical cards expire in the next 30 days.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {alerts.data.alerts.map((a) => (
              <li key={`${a.driver_id}-${a.kind}`} className="flex items-center justify-between py-2">
                <span>
                  <strong>{a.driver_name}</strong> — {a.kind === 'license' ? 'CDL' : 'DOT medical card'}
                </span>
                <span className={a.expired ? 'font-medium text-red-700' : 'text-amber-700'}>
                  {a.expired ? 'Expired' : 'Expires'} {a.expires_on}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="On the road" value={active.length} />
        <Stat label="Planned" value={planned.length} />
        <Stat label="Delivered (all time)" value={loads.data?.loads.filter((l) => l.status === 'delivered').length ?? 0} />
      </div>

      <section className="card overflow-x-auto">
        <h2 className="mb-3 font-medium">On the road</h2>
        <ErrorText error={loads.error} />
        <LoadTable loads={active} />
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card">
      <p className="text-xs text-slate-500 uppercase">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
    </div>
  );
}

export function LoadTable({ loads }: { loads: any[] }) {
  if (loads.length === 0) return <p className="text-sm text-slate-500">Nothing here.</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Load</th>
          <th>Status</th>
          <th>Lane</th>
          <th>Driver</th>
          <th>Truck</th>
          <th className="text-right">Rate</th>
        </tr>
      </thead>
      <tbody>
        {loads.map((l) => (
          <tr key={l.id} className="hover:bg-slate-50">
            <td>
              <Link className="font-medium text-blue-700" to={`/loads/${l.id}`}>{l.load_number}</Link>
              {l.customer_name && <div className="text-xs text-slate-500">{l.customer_name}</div>}
            </td>
            <td><Badge value={l.status} /></td>
            <td>{l.origin} → {l.destination}</td>
            <td>{l.driver_name ?? <span className="text-slate-400">Unassigned</span>}</td>
            <td>{l.truck_unit ?? '—'}</td>
            <td className="text-right tabular-nums">{formatCents(l.rate_cents)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
