import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

test('Полный сценарий, права, валидация, изоляция показов и сохранение после перезапуска', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'maximum-demo-test-'));
  let app;
  let origin;
  async function start() {
    app = createApp({ database: join(dir, 'test.sqlite') });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${app.server.address().port}`;
  }
  async function request(path, input, token) {
    const res = await fetch(origin + path, { method: input === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: res.status, data: await res.json() };
  }
  try {
    await start();
    const employee = (await request('/api/demo/session', { role: 'employee' })).data;
    const manager = (await request('/api/demo/session', { role: 'manager', room: employee.room })).data;
    const payload = { workType: 'drilling', quantity: 4, unit: 'шт.', parameters: 'Бетон, Ø 120 мм, глубина 300 мм', comment: '<script>alert(1)</script>' };
    assert.equal((await request('/api/state')).status, 401);
    assert.equal((await request('/api/arrival', { scenario: 'onsite' }, manager.token)).status, 403);
    assert.equal((await request('/api/report', payload, manager.token)).status, 403);
    assert.equal((await request('/api/report', payload, employee.token)).status, 409);
    assert.equal((await request('/api/arrival', { scenario: 'onsite', latitude: 1 }, employee.token)).status, 400);
    for (const scenario of ['offsite', 'denied', 'unavailable', 'inaccurate']) {
      const attempt = (await request('/api/arrival', { scenario }, employee.token)).data;
      assert.equal(attempt.accepted, false);
      assert.equal(attempt.visit, null);
      assert.equal(attempt.report, null);
    }
    const arrived = (await request('/api/arrival', { scenario: 'onsite' }, employee.token)).data;
    assert.equal(arrived.accepted, true);
    assert.ok(arrived.visit.distance < 150);
    const duplicate = (await request('/api/arrival', { scenario: 'onsite' }, employee.token)).data;
    assert.equal(duplicate.visit.arrived_at, arrived.visit.arrived_at);
    assert.equal(duplicate.attempts.length, 5);
    for (const override of [{ quantity: 0 }, { quantity: 1.5 }, { unit: 'м³' }, { workType: '__proto__' }, { parameters: '  ' }, { latitude: 1 }]) {
      assert.equal((await request('/api/report', { ...payload, ...override }, employee.token)).status, 400);
    }
    const submitted = await request('/api/report', payload, employee.token);
    assert.equal(submitted.status, 201);
    assert.equal(submitted.data.report.quantity, 4);
    assert.ok(submitted.data.report.submitted_at >= arrived.visit.arrived_at);
    assert.equal(Object.hasOwn(submitted.data.report, 'latitude'), false);
    assert.equal(Object.hasOwn(submitted.data.visit, 'departed_at'), false);
    const duplicates = await Promise.all([request('/api/report', payload, employee.token), request('/api/report', payload, employee.token)]);
    for (const result of duplicates) assert.equal(result.data.report.submitted_at, submitted.data.report.submitted_at);
    assert.deepEqual((await request('/api/state', undefined, manager.token)).data.report, submitted.data.report);
    const other = (await request('/api/demo/session', { role: 'employee' })).data;
    assert.equal(other.report, null);
    assert.equal(other.visit, null);
    await app.close();
    await start();
    assert.equal((await request('/api/state', undefined, manager.token)).data.report.parameters, payload.parameters);
    assert.equal((await request('/api/demo/session', { role: 'employee', room: 'nonexistent' })).status, 404);
  } finally { if (app?.server.listening) await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Кабинет руководителя создаёт и редактирует независимые реестры', async () => {
  const app = createApp({ database: ':memory:' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, input, token, method = input === undefined ? 'GET' : 'POST') => {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, data: await response.json() };
  };
  try {
    const manager = (await request('/api/demo/session', { role: 'manager' })).data;
    assert.equal((await request('/api/cabinet/objects')).status, 401);
    assert.equal((await request('/api/cabinet/map-config', undefined, manager.token)).data.enabled, false);
    assert.equal((await request('/api/cabinet/objects', { address: 'Учебный адрес, 1', latitude: 55.7558, longitude: 37.6176, radius: 150 }, manager.token)).status, 201);
    const object = await request('/api/cabinet/objects', { address: 'Учебный адрес, 2', latitude: 55.7558, longitude: 37.6176, radius: 150 }, manager.token);
    assert.equal(object.status, 201);
    assert.equal((await request('/api/cabinet/objects', undefined, manager.token)).data[0].radius, 150);
    assert.equal((await request('/api/cabinet/objects', { address: 'Без точки', latitude: 91, longitude: 37.6176, radius: 150 }, manager.token)).status, 400);
    const employee = await request('/api/cabinet/employees', { full_name: 'Тестов Тест Тестович', birth_date: '1990-04-21', clothing_size: '52', shoe_size: '43', privacy_confirmed_at: '2026-09-28T00:00:00.000Z' }, manager.token);
    assert.equal(employee.status, 201);
    assert.equal(employee.data.privacy_policy_version, 'Тестовая политика 1.0');
    assert.equal((await request('/api/cabinet/employees', { full_name: 'Тестов Тест Тестович', birth_date: '1990-04-21', clothing_size: '52', shoe_size: '43', privacy_policy_version: 'Подменённая версия', privacy_confirmed_at: '2026-09-28T00:00:00.000Z' }, manager.token)).status, 400);
    const equipment = await request('/api/cabinet/equipment', { name: 'Учебная установка', inventory_number: 'TEST-001', equipment_type: 'Буровая установка' }, manager.token);
    assert.equal(equipment.status, 201);
    assert.equal((await request(`/api/cabinet/equipment/${equipment.data.id}`, { name: 'Учебная установка', inventory_number: 'TEST-001', equipment_type: 'Алмазная установка' }, manager.token, 'PUT')).data.equipment_type, 'Алмазная установка');
    assert.equal((await request('/api/cabinet/equipment', { name: 'Другая установка', inventory_number: 'TEST-001', equipment_type: 'Буровая установка' }, manager.token)).status, 409);
  } finally { await app.close(); }
});

test('Конфигурация Яндекс Карт доступна только руководителю и берёт ключ из окружения приложения', async () => {
  const app = createApp({ database: ':memory:', yandexMapsApiKey: 'test-map-key' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const request = async token => {
    const response = await fetch(`${origin}/api/cabinet/map-config`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: response.status, data: await response.json() };
  };
  try {
    assert.equal((await request()).status, 401);
    const session = await fetch(`${origin}/api/demo/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'manager' }) });
    const manager = await session.json();
    const config = await request(manager.token);
    assert.equal(config.status, 200);
    assert.equal(config.data.enabled, true);
    assert.ok(config.data.scriptUrl.includes('apikey=test-map-key'));
  } finally { await app.close(); }
});
