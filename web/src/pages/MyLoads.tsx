import { Link } from 'react-router-dom';
import { Badge, ErrorText, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks';

/** The driver's phone-first home: current load on top, then history. */
export function MyLoads() {
  const { data, error } = useApi<{ loads: any[] }>('/loads');
  if (error) return <ErrorText error={error} />;
  if (!data) return <Loading />;
  const active = data.loads.filter((l) => ['dispatched', 'at_pickup', 'in_transit'].includes(l.status));
  const rest = data.loads.filter((l) => !active.includes(l));
  return (
    <div className="space-y-4">
      <PageHeader title="My loads" />
      {active.length === 0 && <p className="card text-sm text-slate-500">No active load right now.</p>}
      {active.map((l) => (
        <Link key={l.id} to={`/loads/${l.id}`} className="card block border-blue-200 hover:bg-blue-50">
          <div className="flex items-center justify-between">
            <span className="font-semibold">{l.load_number}</span>
            <Badge value={l.status} />
          </div>
          <p className="mt-1 text-lg">{l.origin} → {l.destination}</p>
          <p className="text-sm text-slate-500">Truck {l.truck_unit ?? '—'} · Trailer {l.trailer_unit ?? '—'}</p>
        </Link>
      ))}
      <ul className="card divide-y divide-slate-100 text-sm">
        {rest.map((l) => (
          <li key={l.id} className="py-2">
            <Link to={`/loads/${l.id}`} className="flex items-center justify-between">
              <span><span className="font-medium">{l.load_number}</span> · {l.origin} → {l.destination}</span>
              <Badge value={l.status} />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
