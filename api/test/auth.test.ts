import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { api, PASSWORD } from './helpers';

const signup = (email: string) =>
  api('POST', '/api/auth/signup', { body: { company_name: 'Auth Co', name: 'Pat', email, password: PASSWORD } });

describe('auth', () => {
  it('signs up an owner and returns a working session', async () => {
    const res = await signup('pat@auth.test');
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('owner');
    const me = await api('GET', '/api/auth/me', { token: res.body.token });
    expect(me.body.user.email).toBe('pat@auth.test');
    expect(me.body.user.tenant_name).toBe('Auth Co');
  });

  it('rejects duplicate emails case-insensitively', async () => {
    await signup('dupe@auth.test');
    expect((await signup('DUPE@auth.test')).status).toBe(409);
  });

  it('rejects short passwords', async () => {
    const res = await api('POST', '/api/auth/signup', {
      body: { company_name: 'X', name: 'X', email: 'short@auth.test', password: 'short' },
    });
    expect(res.status).toBe(400);
  });

  it('logs in with the right password only', async () => {
    await signup('login@auth.test');
    expect((await api('POST', '/api/auth/login', { body: { email: 'login@auth.test', password: 'wrong-password' } })).status).toBe(401);
    expect((await api('POST', '/api/auth/login', { body: { email: 'nobody@auth.test', password: PASSWORD } })).status).toBe(401);
    expect((await api('POST', '/api/auth/login', { body: { email: 'Login@Auth.test', password: PASSWORD } })).status).toBe(200);
  });

  it('never stores the plaintext password or token', async () => {
    const res = await signup('stored@auth.test');
    const user = await env.DB.prepare('SELECT password_hash FROM users WHERE email = ?').bind('stored@auth.test').first<{ password_hash: string }>();
    expect(user?.password_hash).not.toContain(PASSWORD);
    expect(user?.password_hash.startsWith('pbkdf2$')).toBe(true);
    const session = await env.DB.prepare('SELECT 1 FROM sessions WHERE id = ?').bind(res.body.token).first();
    expect(session).toBeNull();
  });

  it('requires a session for the API', async () => {
    expect((await api('GET', '/api/loads')).status).toBe(401);
    expect((await api('GET', '/api/loads', { token: 'garbage' })).status).toBe(401);
  });

  it('logout revokes the session', async () => {
    const { body } = await signup('logout@auth.test');
    expect((await api('POST', '/api/auth/logout', { token: body.token })).status).toBe(204);
    expect((await api('GET', '/api/auth/me', { token: body.token })).status).toBe(401);
  });

  it('expired sessions are refused', async () => {
    const { body } = await signup('expired@auth.test');
    await env.DB.prepare(`UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'`).run();
    expect((await api('GET', '/api/auth/me', { token: body.token })).status).toBe(401);
  });

  it('a password change signs the user out everywhere', async () => {
    const owner = (await signup('reset-owner@auth.test')).body.token;
    const created = await api('POST', '/api/users', {
      token: owner,
      body: { email: 'reset-disp@auth.test', name: 'D', role: 'dispatcher', password: PASSWORD },
    });
    const dispToken = (await api('POST', '/api/auth/login', { body: { email: 'reset-disp@auth.test', password: PASSWORD } })).body.token;
    await api('PATCH', `/api/users/${created.body.user.id}`, { token: owner, body: { password: 'a-new-password-1' } });
    expect((await api('GET', '/api/auth/me', { token: dispToken })).status).toBe(401);
  });

  it('an owner cannot delete their own login', async () => {
    const owner = await signup('self@auth.test');
    expect((await api('DELETE', `/api/users/${owner.body.user.id}`, { token: owner.body.token })).status).toBe(400);
  });
});
