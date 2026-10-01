import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresDatabase } from './postgres-db.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const WORK_TYPES = {
  drilling: { label: 'Алмазное сверление и бурение', units: ['шт.', 'пог. м'] },
  cutting: { label: 'Резка бетона и кирпича', units: ['пог. м', 'м²'] },
  openings: { label: 'Изготовление и усиление проёмов', units: ['шт.'] },
  demolition: { label: 'Демонтаж', units: ['м²', 'м³'] },
  chasing: { label: 'Штробление', units: ['пог. м'] },
  repair: { label: 'Ремонтно-строительные работы', units: ['м²', 'шт.'] },
  cores: { label: 'Отбор кернов', units: ['шт.'] },
};
const OBJECT = {
  name: 'Учебный объект · Корпус А',
  address: 'Демонстрационный город, Строительная улица, 12',
  task: 'Выполнить согласованные работы в техническом помещении первого этажа.',
  radius: 150,
  latitude: 55.75,
  longitude: 37.61,
  equipment: ['Установка алмазного сверления · учебная № 1', 'Комплект инструмента · учебный № 2'],
};
const EMPLOYEE = 'Тестовый сотрудник';
const CURRENT_PRIVACY_POLICY_VERSION = 'Тестовая политика 1.0';
const GEO_CASES = {
  onsite: { latitude: 55.75018, longitude: 37.6101, accuracy: 12 },
  offsite: { latitude: 55.767, longitude: 37.63, accuracy: 15 },
  inaccurate: { latitude: 55.75018, longitude: 37.6101, accuracy: 800 },
};
export { WORK_TYPES, OBJECT, EMPLOYEE, GEO_CASES };

export function distanceMeters(a, b) {
  const rad = n => n * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(status, message) { throw new ApiError(status, message); }
async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 16384) fail(413, 'Слишком большой запрос. Сократите текст отчёта.');
  }
  try { return JSON.parse(raw || '{}'); } catch { fail(400, 'Не удалось прочитать запрос.'); }
}

export async function createApp({ database = process.env.DATABASE_URL, yandexMapsApiKey = process.env.YANDEX_MAPS_API_KEY } = {}) {
  if (!database) throw new Error('DATABASE_URL не настроен.');
  const db = createPostgresDatabase(database);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), role TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS visits (room_id TEXT PRIMARY KEY REFERENCES rooms(id), arrived_at TEXT NOT NULL, distance INTEGER NOT NULL, accuracy INTEGER NOT NULL, employee TEXT NOT NULL, object_name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts (id BIGSERIAL PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), created_at TEXT NOT NULL, outcome TEXT NOT NULL, message TEXT NOT NULL, distance INTEGER);
    CREATE TABLE IF NOT EXISTS reports (room_id TEXT PRIMARY KEY REFERENCES rooms(id), submitted_at TEXT NOT NULL, work_type TEXT NOT NULL, work_label TEXT NOT NULL, quantity REAL NOT NULL, unit TEXT NOT NULL, parameters TEXT NOT NULL, comment TEXT NOT NULL, employee TEXT NOT NULL, object_name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cabinet_objects (id BIGSERIAL PRIMARY KEY, address TEXT NOT NULL UNIQUE, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, radius INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cabinet_employees (id BIGSERIAL PRIMARY KEY, full_name TEXT NOT NULL, birth_date TEXT NOT NULL, clothing_size TEXT NOT NULL, shoe_size TEXT NOT NULL, privacy_policy_version TEXT NOT NULL, privacy_confirmed_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cabinet_equipment (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, inventory_number TEXT NOT NULL UNIQUE, equipment_type TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const authenticate = async (req, role) => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const session = await db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?').get(token, Date.now());
    if (!session) fail(401, 'Сеанс показа истёк. Откройте демонстрацию заново.');
    if (role && session.role !== role) fail(403, 'Это действие недоступно для выбранной роли.');
    return session;
  };
  const state = async session => ({
    room: session.room_id,
    role: session.role,
    employee: EMPLOYEE,
    object: OBJECT,
    workTypes: WORK_TYPES,
    visit: await db.prepare('SELECT * FROM visits WHERE room_id = ?').get(session.room_id) || null,
    report: await db.prepare('SELECT * FROM reports WHERE room_id = ?').get(session.room_id) || null,
    attempts: await db.prepare('SELECT created_at, outcome, message, distance FROM attempts WHERE room_id = ? ORDER BY id DESC LIMIT 20').all(session.room_id),
    serverTime: new Date().toISOString(),
  });
  const assets = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
    '/cabinet': ['cabinet.html', 'text/html; charset=utf-8'],
    '/cabinet.js': ['cabinet.js', 'text/javascript; charset=utf-8'],
    '/cabinet.css': ['cabinet.css', 'text/css; charset=utf-8'],
  };
  const text = (value, field, max = 200) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(400, `Проверьте поле «${field}».`);
    return value.trim();
  };
  const cabinet = {
    objects: {
      table: 'cabinet_objects',
      fields: ['address', 'latitude', 'longitude', 'radius'],
      labels: { address: 'Адрес объекта', latitude: 'Широта', longitude: 'Долгота', radius: 'Радиус объекта' },
    },
    employees: {
      table: 'cabinet_employees',
      fields: ['full_name', 'birth_date', 'clothing_size', 'shoe_size', 'privacy_policy_version', 'privacy_confirmed_at'],
      labels: { full_name: 'ФИО', birth_date: 'Дата рождения', clothing_size: 'Размер одежды', shoe_size: 'Размер обуви', privacy_policy_version: 'Версия политики', privacy_confirmed_at: 'Подтверждение политики' },
    },
    equipment: {
      table: 'cabinet_equipment',
      fields: ['name', 'inventory_number', 'equipment_type'],
      labels: { name: 'Название', inventory_number: 'Инвентарный номер', equipment_type: 'Тип оборудования' },
    },
  };
  const cabinetResource = pathname => {
    const match = /^\/api\/cabinet\/(objects|employees|equipment)(?:\/(\d+))?$/.exec(pathname);
    if (!match) return null;
    return { key: match[1], id: match[2] ? Number(match[2]) : null, ...cabinet[match[1]] };
  };
  const cabinetValue = (resource, input) => {
    const inputFields = resource.key === 'employees' ? resource.fields.filter(field => field !== 'privacy_policy_version') : resource.fields;
    if (!input || Object.keys(input).some(key => !inputFields.includes(key))) fail(400, 'В карточке есть неподдерживаемые поля.');
    const value = Object.fromEntries(resource.fields.map(field => [field, field === 'privacy_policy_version' ? CURRENT_PRIVACY_POLICY_VERSION : resource.key === 'objects' && ['latitude', 'longitude', 'radius'].includes(field) ? input[field] : text(input[field], resource.labels[field])]));
    if (resource.key === 'objects') {
      for (const field of ['latitude', 'longitude', 'radius']) value[field] = input[field];
      if (!Number.isFinite(value.latitude) || value.latitude < -90 || value.latitude > 90) fail(400, 'Укажите точку объекта на карте.');
      if (!Number.isFinite(value.longitude) || value.longitude < -180 || value.longitude > 180) fail(400, 'Укажите точку объекта на карте.');
      if (!Number.isInteger(value.radius) || value.radius < 10 || value.radius > 5000) fail(400, 'Радиус объекта должен быть от 10 до 5 000 м.');
    }
    if (resource.key === 'employees' && !/^\d{4}-\d{2}-\d{2}$/.test(value.birth_date)) fail(400, 'Укажите дату рождения.');
    return value;
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // JS API Яндекс Карт авторизует загрузку по Referer разрешённого HTTPS-контура.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://api-maps.yandex.ru https://yastatic.net; style-src 'self' 'unsafe-inline' https://yastatic.net; img-src 'self' data: https://*.maps.yandex.ru https://*.yandex.ru https://*.maps.yandex.net; connect-src 'self' https://*.maps.yandex.ru https://*.yandex.ru https://*.maps.yandex.net https://yastatic.net; worker-src 'self' blob: data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && assets[url.pathname]) {
        const [file, type] = assets[url.pathname];
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        return res.end(readFileSync(join(root, 'public', file)));
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, app: 'maximum-scenario-demo', mode: 'synthetic-only' });
      if (['POST', 'PUT'].includes(req.method)) {
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') fail(415, 'Ожидается JSON.');
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) fail(403, 'Запрос с другого сайта запрещён.');
      }
      const resource = cabinetResource(url.pathname);
      if (req.method === 'GET' && url.pathname === '/api/cabinet/map-config') {
        await authenticate(req, 'manager');
        const key = typeof yandexMapsApiKey === 'string' ? yandexMapsApiKey.trim() : '';
        return json(res, 200, { provider: 'yandex', enabled: Boolean(key), scriptUrl: key ? `https://api-maps.yandex.ru/v3/?apikey=${encodeURIComponent(key)}&lang=ru_RU` : null });
      }
      if (resource && req.method === 'GET') {
        await authenticate(req, 'manager');
        if (resource.id) {
          const record = await db.prepare(`SELECT * FROM ${resource.table} WHERE id = ?`).get(resource.id);
          if (!record) fail(404, 'Карточка не найдена.');
          return json(res, 200, record);
        }
        return json(res, 200, await db.prepare(`SELECT * FROM ${resource.table} ORDER BY updated_at DESC, id DESC`).all());
      }
      if (resource && req.method === 'POST' && !resource.id) {
        await authenticate(req, 'manager');
        const value = cabinetValue(resource, await body(req));
        const now = new Date().toISOString();
        const names = resource.fields.join(', ');
        const marks = resource.fields.map(() => '?').join(', ');
        try {
          const result = await db.prepare(`INSERT INTO ${resource.table} (${names}, created_at, updated_at) VALUES (${marks}, ?, ?) RETURNING id`).run(...resource.fields.map(field => value[field]), now, now);
          return json(res, 201, await db.prepare(`SELECT * FROM ${resource.table} WHERE id = ?`).get(result.lastInsertRowid));
        } catch (error) {
          if (error.message?.includes('UNIQUE constraint failed')) fail(409, resource.key === 'equipment' ? 'Такой инвентарный номер уже есть.' : 'Такая запись уже существует.');
          throw error;
        }
      }
      if (resource && req.method === 'PUT' && resource.id) {
        await authenticate(req, 'manager');
        const value = cabinetValue(resource, await body(req));
        const now = new Date().toISOString();
        const set = resource.fields.map(field => `${field} = ?`).join(', ');
        try {
          const result = await db.prepare(`UPDATE ${resource.table} SET ${set}, updated_at = ? WHERE id = ?`).run(...resource.fields.map(field => value[field]), now, resource.id);
          if (!result.changes) fail(404, 'Карточка не найдена.');
          return json(res, 200, await db.prepare(`SELECT * FROM ${resource.table} WHERE id = ?`).get(resource.id));
        } catch (error) {
          if (error.message?.includes('UNIQUE constraint failed')) fail(409, 'Такой инвентарный номер уже есть.');
          throw error;
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/demo/session') {
        const input = await body(req);
        if (!['employee', 'manager'].includes(input.role)) fail(400, 'Выберите роль.');
        let room = input.room;
        if (!room) {
          room = randomBytes(12).toString('hex');
          await db.prepare('INSERT INTO rooms VALUES (?, ?)').run(room, new Date().toISOString());
        } else if (typeof room !== 'string' || !await db.prepare('SELECT id FROM rooms WHERE id = ?').get(room)) {
          fail(404, 'Этот показ не найден. Начните новый показ.');
        }
        const token = randomBytes(32).toString('hex');
        await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
        await db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(token, room, input.role, Date.now() + 24 * 3600 * 1000);
        return json(res, 201, { token, ...(await state({ room_id: room, role: input.role })) });
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await state(await authenticate(req)));
      if (req.method === 'POST' && url.pathname === '/api/arrival') {
        const session = await authenticate(req, 'employee');
        const input = await body(req);
        const existing = await db.prepare('SELECT * FROM visits WHERE room_id = ?').get(session.room_id);
        if (existing) return json(res, 200, { accepted: true, message: 'Прибытие уже зафиксировано.', ...(await state(session)) });
        if (Object.keys(input).some(key => key !== 'scenario')) fail(400, 'В демонстрации принимаются только тестовые ситуации, без реальных координат.');
        if (!['onsite', 'offsite', 'inaccurate', 'denied', 'unavailable'].includes(input.scenario)) fail(400, 'Выберите тестовую ситуацию.');
        const point = GEO_CASES[input.scenario];
        const distance = point ? Math.round(distanceMeters(OBJECT, point)) : null;
        const accepted = !!point && distance + point.accuracy <= OBJECT.radius;
        let message;
        if (input.scenario === 'denied') message = 'Нет доступа к геопозиции. Разрешите доступ в настройках телефона и повторите попытку.';
        else if (input.scenario === 'unavailable') message = 'Не удалось получить геопозицию. Попробуйте ещё раз. Прибытие пока не отмечено.';
        else if (input.scenario === 'inaccurate') message = 'Геопозиция слишком неточная. Перейдите на открытое место и повторите попытку.';
        else if (!accepted) message = `Вы вне объекта: расстояние ${distance} м, допустимый радиус ${OBJECT.radius} м. Отметиться можно после прибытия.`;
        else message = 'Прибытие зафиксировано. После работы сдайте персональный отчёт.';
        const now = new Date().toISOString();
        await db.transaction(async tx => {
          await tx.prepare('INSERT INTO attempts (room_id, created_at, outcome, message, distance) VALUES (?, ?, ?, ?, ?)').run(session.room_id, now, accepted ? 'accepted' : input.scenario, message, distance);
          if (accepted) await tx.prepare('INSERT INTO visits VALUES (?, ?, ?, ?, ?, ?)').run(session.room_id, now, distance, point.accuracy, EMPLOYEE, OBJECT.name);
        });
        return json(res, 200, { accepted, message, ...(await state(session)) });
      }
      if (req.method === 'POST' && url.pathname === '/api/report') {
        const session = await authenticate(req, 'employee');
        const input = await body(req);
        if (!await db.prepare('SELECT room_id FROM visits WHERE room_id = ?').get(session.room_id)) fail(409, 'Сначала отметьте прибытие на объект.');
        if (await db.prepare('SELECT room_id FROM reports WHERE room_id = ?').get(session.room_id)) return json(res, 200, { message: 'Отчёт уже принят.', ...(await state(session)) });
        if (Object.keys(input).some(key => !['workType', 'quantity', 'unit', 'parameters', 'comment'].includes(key))) fail(400, 'В отчёте есть неподдерживаемые поля.');
        const type = WORK_TYPES[input.workType];
        if (!Object.hasOwn(WORK_TYPES, input.workType) || !type.units.includes(input.unit)) fail(400, 'Выберите вид работ и соответствующую единицу измерения.');
        if (typeof input.quantity !== 'number' || !Number.isFinite(input.quantity) || input.quantity <= 0 || input.quantity > 100000) fail(400, 'Укажите объём работ больше нуля и не больше 100 000.');
        if (input.unit === 'шт.' && !Number.isInteger(input.quantity)) fail(400, 'Количество в штуках должно быть целым.');
        for (const field of ['parameters', 'comment']) if (typeof input[field] !== 'string' || input[field].length > 2000) fail(400, 'Текст каждого поля должен быть не длиннее 2000 символов.');
        if (!input.parameters.trim()) fail(400, 'Укажите параметры выполненных работ.');
        await db.prepare('INSERT INTO reports VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(session.room_id, new Date().toISOString(), input.workType, type.label, input.quantity, input.unit, input.parameters.trim(), input.comment.trim(), EMPLOYEE, OBJECT.name);
        return json(res, 201, { message: 'Отчёт принят.', ...(await state(session)) });
      }
      fail(404, 'Страница не найдена.');
    } catch (error) {
      if (!(error instanceof ApiError)) console.error('Ошибка приложения:', error.code || error.name);
      json(res, error.status || 500, { error: error.status ? error.message : 'Не удалось сохранить данные. Повторите попытку; заполненный отчёт останется на экране.' });
    }
  });
  return { server, db, close: () => new Promise(resolve => server.close(async () => { await db.close(); resolve(); })) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = await createApp({ database: process.env.DATABASE_URL });
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 4173);
  app.server.listen(port, host, () => console.log(`MAXIMUM demo: http://${host}:${port} · synthetic-only`));
  app.server.on('error', error => { console.error('Не удалось запустить демонстрацию:', error.code); process.exitCode = 1; app.db.close(); });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => app.close().then(() => process.exit(0)));
}
