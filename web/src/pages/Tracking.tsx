import { ErrorText, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks';

const hm = (min: number | null) => (min === null ? '—' : `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`);

/** Where the trucks are (Traccar) and how many hours drivers have left (ELD vendor). */
export function Tracking() {
  const gps = useApi<{ trucks: any[] }>('/tracking/positions');
  const hos = useApi<any>('/hos/clocks');
  return (
    <div className="space-y-6">
      <PageHeader title="Fleet" />
      <section className="card space-y-2 overflow-x-auto">
        <h2 className="font-medium">Locations</h2>
        {gps.error ? <p className="text-sm text-slate-600">{gps.error}</p> : !gps.data ? <Loading /> : (
          <table className="table">
            <thead><tr><th>Truck</th><th>Driver / load</th><th>Last fix</th><th>Speed</th><th>Where</th></tr></thead>
            <tbody>
              {gps.data.trucks.map((t) => (
                <tr key={t.id}>
                  <td className="font-medium">{t.unit_number}</td>
                  <td>{t.driver_name ?? '—'} {t.load_number && <span className="text-slate-500">· {t.load_number}</span>}</td>
                  <td>{t.position ? new Date(t.position.fix_time).toLocaleString() : t.traccar_device_id ? 'No fix yet' : <span className="text-slate-400">No GPS device mapped</span>}</td>
                  <td>{t.position ? `${t.position.speed_mph} mph` : '—'}</td>
                  <td>{t.position ? <a className="text-blue-700" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${t.position.latitude}&mlon=${t.position.longitude}#map=11/${t.position.latitude}/${t.position.longitude}`}>{t.position.address ?? `${t.position.latitude.toFixed(4)}, ${t.position.longitude.toFixed(4)}`}</a> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card space-y-2 overflow-x-auto">
        <h2 className="font-medium">Hours of service {hos.data && <span className="text-sm font-normal text-slate-500">from {hos.data.provider}</span>}</h2>
        {hos.error ? <p className="text-sm text-slate-600">{hos.error}</p> : !hos.data ? <Loading /> : (
          <>
            <table className="table">
              <thead><tr><th>Driver</th><th>Status</th><th>Drive left</th><th>Shift left</th><th>Cycle left</th><th>Break due</th></tr></thead>
              <tbody>
                {hos.data.drivers.map((d: any) => (
                  <tr key={d.driver_id}>
                    <td className="font-medium">{d.name}</td>
                    {d.clock ? (
                      <>
                        <td>{d.clock.duty_status ?? '—'}</td>
                        <td className={d.clock.drive_remaining_min !== null && d.clock.drive_remaining_min < 60 ? 'text-red-700' : ''}>{hm(d.clock.drive_remaining_min)}</td>
                        <td>{hm(d.clock.shift_remaining_min)}</td><td>{hm(d.clock.cycle_remaining_min)}</td><td>{hm(d.clock.break_due_in_min)}</td>
                      </>
                    ) : <td colSpan={5} className="text-slate-400">{d.eld_driver_id ? 'No clock from ELD' : 'Set the ELD driver ID on the driver profile'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            {hos.data.unmapped.length > 0 && <p className="text-xs text-slate-500">ELD drivers not linked: {hos.data.unmapped.map((u: any) => `${u.name} (${u.eld_driver_id})`).join(', ')}</p>}
          </>
        )}
      </section>
    </div>
  );
}
