import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkApp } from '../work-server.mjs';

test('рабочий вход создаёт индивидуальную сессию без хранения пароля', async () => {
  const app = createWorkApp({ database: ':memory:', yandexMapsApiKey: 'test-key', bootstrapAdmin: { login: 'manager.maximum', password: 'correct-horse-battery-2026' } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, body, token, method = body === undefined ? 'GET' : 'POST') => { const res = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, data: res.status === 204 ? null : await res.json() }; };
  try {
    assert.equal((await request('/api/auth/session')).status, 401);
    assert.equal((await request('/api/auth/login', { login: 'manager.maximum', password: 'wrong-password' })).status, 401);
    const login = await request('/api/auth/login', { login: 'manager.maximum', password: 'correct-horse-battery-2026' });
    assert.equal(login.status, 201);
    assert.equal(login.data.user.role, 'manager');
    assert.equal((await request('/api/auth/session', undefined, login.data.token)).data.user.login, 'manager.maximum');
    assert.equal(app.db.prepare('SELECT password_hash FROM users').get().password_hash.includes('correct-horse'), false);
    assert.equal((await request('/api/manager/objects')).status, 401);
    assert.equal((await request('/api/manager/map-config', undefined, login.data.token)).data.enabled, true);
    const object = await request('/api/manager/objects', { address: 'Учебный адрес, 1', latitude: 55.7558, longitude: 37.6176, radius: 150 }, login.data.token);
    assert.equal(object.status, 201);
    assert.equal(object.data.radius, 150);
    assert.equal((await request('/api/manager/objects', undefined, login.data.token)).data[0].address, 'Учебный адрес, 1');
    const photo = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0XQAAAABJRU5ErkJggg==';
    const employee = await request('/api/manager/employees', { full_name: 'Тестов Тест Тестович', email: 'testov@example.test', phone: '+7 900 123-45-67', birth_date: '1990-04-21', clothing_size: '52', shoe_size: '43', privacy_confirmed_at: '2026-09-29T00:00:00.000Z', photo_data: { type: 'image/png', base64: photo } }, login.data.token);
    assert.equal(employee.status, 201);
    assert.equal(employee.data.privacy_policy_version, 'Тестовая политика 1.0');
    assert.equal(employee.data.photo_mime, 'image/png');
    const storedPhoto = await fetch(`${origin}/api/manager/employees/${employee.data.id}/photo`, { headers: { Authorization: `Bearer ${login.data.token}` } });
    assert.equal(storedPhoto.status, 200);
    assert.equal(storedPhoto.headers.get('content-type'), 'image/png');
    assert.ok((await storedPhoto.arrayBuffer()).byteLength > 0);
    assert.equal(app.db.prepare('SELECT state FROM work_employee_access WHERE employee_id=?').get(employee.data.id).state, 'pending_activation');
    const equipment = await request('/api/manager/equipment', { name: 'Учебная установка', inventory_number: 'TEST-001', equipment_type: 'Буровая установка' }, login.data.token);
    assert.equal(equipment.status, 201);
    assert.equal((await request(`/api/manager/equipment/${equipment.data.id}`, { name: 'Учебная установка', inventory_number: 'TEST-001', equipment_type: 'Алмазная установка' }, login.data.token, 'PUT')).data.equipment_type, 'Алмазная установка');
    app.db.prepare("UPDATE users SET role='employee' WHERE id=?").run(login.data.user.id);
    assert.equal((await request('/api/manager/objects', undefined, login.data.token)).status, 403);
    assert.equal((await request('/api/auth/logout', {}, login.data.token)).status, 204);
    assert.equal((await request('/api/auth/session', undefined, login.data.token)).status, 401);
  } finally { await app.close(); }
});
