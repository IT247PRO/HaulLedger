import { beforeAll, describe, expect, it } from 'vitest';
import { api, fetchRaw, makeCarrier, stops, upload, type Carrier } from './helpers';

let c: Carrier;
let other: Carrier;
beforeAll(async () => {
  c = await makeCarrier('Docs');
  other = await makeCarrier('OtherDocs');
});

describe('documents', () => {
  it('a driver uploads a POD photo from the phone and it marks the load', async () => {
    const photo = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], 'pod.jpg', { type: 'image/jpeg' });
    const res = await upload(c.tokens.driver, { kind: 'pod', load_id: c.load.id }, photo);
    expect(res.status).toBe(201);
    expect(res.body.document).not.toHaveProperty('r2_key');
    const load = await api('GET', `/api/loads/${c.load.id}`, { token: c.tokens.owner });
    expect(load.body.load.pod_received_at).toBeTruthy();
    expect(load.body.load.documents.map((d: any) => d.kind)).toContain('pod');

    const file = await fetchRaw(c.tokens.owner, `/api/documents/${res.body.document.id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  });

  it("a driver cannot upload to another driver's load or upload a rate confirmation", async () => {
    const otherLoad = (await api('POST', '/api/loads', { token: c.tokens.owner, body: { driver_id: c.otherDriver.id, stops } })).body.load;
    expect((await upload(c.tokens.driver, { kind: 'pod', load_id: otherLoad.id })).status).toBe(404);
    expect((await upload(c.tokens.driver, { kind: 'rate_confirmation', load_id: c.load.id })).status).toBe(403);
  });

  it('rejects unsupported files', async () => {
    const exe = new File(['MZ'], 'x.exe', { type: 'application/x-msdownload' });
    expect((await upload(c.tokens.owner, { kind: 'other', load_id: c.load.id }, exe)).status).toBe(400);
    expect((await upload(c.tokens.owner, { kind: 'pod' })).status).toBe(400); // POD needs a load
  });

  it('a driver not paid by percentage never sees the rate confirmation', async () => {
    const rc = await upload(c.tokens.owner, { kind: 'rate_confirmation', load_id: c.load.id });
    expect(rc.status).toBe(201);
    expect((await fetchRaw(c.tokens.driver, `/api/documents/${rc.body.document.id}/file`)).status).toBe(404);
    const load = await api('GET', `/api/loads/${c.load.id}`, { token: c.tokens.driver });
    expect(load.body.load.documents.map((d: any) => d.kind)).not.toContain('rate_confirmation');
  });

  it("documents never cross tenants", async () => {
    const doc = await upload(c.tokens.owner, { kind: 'bol', load_id: c.load.id });
    for (const role of ['owner', 'dispatcher', 'driver'] as const) {
      expect((await fetchRaw(other.tokens[role], `/api/documents/${doc.body.document.id}/file`)).status).toBe(404);
    }
    expect((await api('DELETE', `/api/documents/${doc.body.document.id}`, { token: other.tokens.owner })).status).toBe(404);
    expect((await upload(other.tokens.owner, { kind: 'bol', load_id: c.load.id })).status).toBe(400);
    const list = await api('GET', `/api/documents?load_id=${c.load.id}`, { token: other.tokens.owner });
    expect(list.body.documents).toEqual([]);
  });

  it('deleting the only POD clears the POD flag', async () => {
    const load = (await api('POST', '/api/loads', { token: c.tokens.owner, body: { stops } })).body.load;
    const pod = await upload(c.tokens.owner, { kind: 'pod', load_id: load.id });
    expect((await api('DELETE', `/api/documents/${pod.body.document.id}`, { token: c.tokens.dispatcher })).status).toBe(204);
    expect((await api('GET', `/api/loads/${load.id}`, { token: c.tokens.owner })).body.load.pod_received_at).toBeNull();
    expect((await api('DELETE', `/api/documents/${pod.body.document.id}`, { token: c.tokens.driver })).status).toBe(403);
  });
});
