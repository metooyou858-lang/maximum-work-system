import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkApp } from '../work-server.mjs';

test('рабочий вход создаёт индивидуальную сессию без хранения пароля', async () => {
  const app = createWorkApp({ database: ':memory:', bootstrapAdmin: { login: 'manager.maximum', password: 'correct-horse-battery-2026' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, body, token) => { const res = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, data: res.status === 204 ? null : await res.json() }; };
  try {
    assert.equal((await request('/api/auth/session')).status, 401);
    assert.equal((await request('/api/auth/login', { login: 'manager.maximum', password: 'wrong-password' })).status, 401);
    const login = await request('/api/auth/login', { login: 'manager.maximum', password: 'correct-horse-battery-2026' });
    assert.equal(login.status, 201);
    assert.equal(login.data.user.role, 'manager');
    assert.equal((await request('/api/auth/session', undefined, login.data.token)).data.user.login, 'manager.maximum');
    assert.equal(app.db.prepare('SELECT password_hash FROM users').get().password_hash.includes('correct-horse'), false);
    assert.equal((await request('/api/auth/logout', {}, login.data.token)).status, 204);
    assert.equal((await request('/api/auth/session', undefined, login.data.token)).status, 401);
  } finally { await app.close(); }
});
