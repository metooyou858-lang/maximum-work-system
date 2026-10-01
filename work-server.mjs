import http from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresDatabase } from './postgres-db.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const sessionDays = 7;
const roles = new Set(['manager', 'foreman', 'employee']);
const privacyPolicyVersion = 'Тестовая политика 1.0';

const passwordHash = password => {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`;
};
const passwordMatches = (password, stored) => {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(hashHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const cleanLogin = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{2,63}$/i.test(value) ? value.toLowerCase() : null;

export async function createWorkApp({ database = process.env.DATABASE_URL, bootstrapAdmin, yandexMapsApiKey = process.env.YANDEX_MAPS_API_KEY, yandexGeocoderApiKey = process.env.YANDEX_GEOCODER_API_KEY } = {}) {
  if (!database) throw new Error('DATABASE_URL не настроен.');
  const db = createPostgresDatabase(database);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (id BIGSERIAL PRIMARY KEY, login TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('manager','foreman','employee')), status TEXT NOT NULL CHECK(status IN ('active','suspended')), employee_id BIGINT UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_sessions (token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id), expires_at BIGINT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_log (id BIGSERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(id), event TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_objects (id BIGSERIAL PRIMARY KEY, contractor_name TEXT NOT NULL DEFAULT '', address TEXT NOT NULL UNIQUE, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, radius INTEGER, address_verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_employees (id BIGSERIAL PRIMARY KEY, full_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT NOT NULL, birth_date TEXT NOT NULL, clothing_size TEXT NOT NULL, shoe_size TEXT NOT NULL, photo_file TEXT, photo_mime TEXT, privacy_policy_version TEXT NOT NULL, privacy_confirmed_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_equipment (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, inventory_number TEXT NOT NULL UNIQUE, equipment_type TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_employee_access (employee_id BIGINT PRIMARY KEY REFERENCES work_employees(id), user_id BIGINT UNIQUE REFERENCES users(id), state TEXT NOT NULL CHECK(state IN ('pending_activation','active','suspended')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  const hasColumn = async (table, column) => (await db.prepare('SELECT column_name FROM information_schema.columns WHERE table_name=? AND column_name=?').all(table, column)).length > 0;
  if (bootstrapAdmin && await db.prepare('SELECT 1 FROM users LIMIT 1').get() === undefined) {
    const login = cleanLogin(bootstrapAdmin.login);
    if (!login || typeof bootstrapAdmin.password !== 'string' || bootstrapAdmin.password.length < 14) throw new Error('Для первого руководителя нужны логин и пароль не короче 14 символов.');
    await db.prepare('INSERT INTO users (login, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id').run(login, passwordHash(bootstrapAdmin.password), 'manager', 'active', new Date().toISOString());
  }
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const tokenHash = token => scryptSync(token, 'maximum-session-v1', 32).toString('hex');
  const currentUser = async req => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const row = await db.prepare('SELECT u.id, u.login, u.role FROM work_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.status=?').get(tokenHash(token), Date.now(), 'active');
    return row || null;
  };
  const audit = (userId, event) => db.prepare('INSERT INTO audit_log (user_id, event, created_at) VALUES (?, ?, ?)').run(userId, event, new Date().toISOString());
  const readJson = async req => { let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 7 * 1024 * 1024) throw new Error('Файл слишком большой. Выберите фотографию до 5 МБ.'); } try { return JSON.parse(raw || '{}'); } catch { throw new Error('Не удалось прочитать запрос.'); } };
  const requireManager = async req => {
    const user = await currentUser(req);
    if (!user) { const error = new Error('auth'); error.status = 401; throw error; }
    if (user.role !== 'manager') { const error = new Error('role'); error.status = 403; throw error; }
    return user;
  };
  const text = (value, label) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) { const error = new Error(`Проверьте поле «${label}».`); error.status = 400; throw error; }
    return value.trim();
  };
  const resources = {
    objects: { table: 'work_objects', fields: ['contractor_name', 'address', 'latitude', 'longitude', 'radius', 'address_verified'], labels: { contractor_name: 'Наименование подрядчика', address: 'Адрес объекта', latitude: 'Широта', longitude: 'Долгота', radius: 'Радиус объекта' } },
    employees: { table: 'work_employees', fields: ['full_name', 'email', 'phone', 'birth_date', 'clothing_size', 'shoe_size', 'privacy_policy_version', 'privacy_confirmed_at'], labels: { full_name: 'ФИО', email: 'Личный email', phone: 'Телефон', birth_date: 'Дата рождения', clothing_size: 'Размер одежды', shoe_size: 'Размер обуви', privacy_confirmed_at: 'Подтверждение политики' } },
    equipment: { table: 'work_equipment', fields: ['name', 'inventory_number', 'equipment_type'], labels: { name: 'Название', inventory_number: 'Инвентарный номер', equipment_type: 'Тип оборудования' } },
  };
  const resourceFor = pathname => {
    const match = /^\/api\/manager\/(objects|employees|equipment)(?:\/(\d+))?$/.exec(pathname);
    return match ? { key: match[1], id: match[2] ? Number(match[2]) : null, ...resources[match[1]] } : null;
  };
  const photoFor = input => {
    if (input === undefined) return null;
    if (!input || typeof input !== 'object' || typeof input.type !== 'string' || typeof input.base64 !== 'string') { const error = new Error('Не удалось прочитать фотографию.'); error.status = 400; throw error; }
    const allowed = { 'image/jpeg': { extension: 'jpg', signature: bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff }, 'image/png': { extension: 'png', signature: bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) }, 'image/webp': { extension: 'webp', signature: bytes => bytes.subarray(0, 4).equals(Buffer.from('RIFF')) && bytes.subarray(8, 12).equals(Buffer.from('WEBP')) } };
    const format = allowed[input.type]; const bytes = Buffer.from(input.base64, 'base64');
    if (!format || !bytes.length || bytes.length > 5 * 1024 * 1024 || !format.signature(bytes)) { const error = new Error('Загрузите JPG, PNG или WebP размером до 5 МБ.'); error.status = 400; throw error; }
    return { bytes, mime: input.type, extension: format.extension };
  };
  const valueFor = async (resource, req) => {
    const input = await readJson(req);
    const photo = resource.key === 'employees' ? photoFor(input.photo_data) : null;
    const writable = resource.key === 'employees' ? resource.fields.filter(field => field !== 'privacy_policy_version') : resource.fields;
    if (!input || Object.keys(input).some(key => !writable.includes(key) && key !== 'photo_data')) { const error = new Error('В карточке есть неподдерживаемые поля.'); error.status = 400; throw error; }
    const value = Object.fromEntries(resource.fields.map(field => [field, field === 'privacy_policy_version' ? privacyPolicyVersion : field === 'address_verified' ? (input.address_verified === true ? 1 : 0) : resource.key === 'objects' && ['latitude', 'longitude', 'radius'].includes(field) ? Number(input[field]) : text(input[field], resource.labels[field]) ]));
    if (resource.key === 'objects') {
      if (value.address_verified !== 1) { const error = new Error('Подтвердите адрес выбором найденного объекта на Яндекс Карте.'); error.status = 400; throw error; }
      if (!Number.isFinite(value.latitude) || value.latitude < -90 || value.latitude > 90) { const error = new Error('Укажите точку объекта на карте.'); error.status = 400; throw error; }
      if (!Number.isFinite(value.longitude) || value.longitude < -180 || value.longitude > 180) { const error = new Error('Укажите точку объекта на карте.'); error.status = 400; throw error; }
      if (!Number.isInteger(value.radius) || value.radius < 10 || value.radius > 5000) { const error = new Error('Радиус объекта должен быть от 10 до 5 000 м.'); error.status = 400; throw error; }
    }
    if (resource.key === 'employees' && !/^\d{4}-\d{2}-\d{2}$/.test(value.birth_date)) { const error = new Error('Укажите дату рождения.'); error.status = 400; throw error; }
    if (resource.key === 'employees' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) { const error = new Error('Укажите личный email в обычном формате.'); error.status = 400; throw error; }
    if (resource.key === 'employees' && !/^[0-9+()\-\s]{7,30}$/.test(value.phone)) { const error = new Error('Укажите телефон в обычном формате.'); error.status = 400; throw error; }
    return { value, photo };
  };
  const assets = {
    '/': ['work-cabinet.html', 'text/html; charset=utf-8'],
    '/work-cabinet.js': ['work-cabinet.js', 'text/javascript; charset=utf-8'],
    '/work-cabinet.css': ['work-cabinet.css', 'text/css; charset=utf-8'],
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://api-maps.yandex.ru https://yastatic.net https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://yastatic.net https://cdn.jsdelivr.net; img-src 'self' data: https://*.maps.yandex.ru https://*.yandex.ru https://*.maps.yandex.net; connect-src 'self' https://*.maps.yandex.ru https://*.yandex.ru https://*.maps.yandex.net https://yastatic.net https://cdn.jsdelivr.net; worker-src 'self' blob: data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && assets[url.pathname]) {
        const [file, type] = assets[url.pathname];
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        return res.end(readFileSync(join(root, 'public', file)));
      }
      if (['POST', 'PUT'].includes(req.method)) {
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: 'Ожидается JSON.' });
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { error: 'Запрос с другого сайта запрещён.' });
      }
      if (req.method === 'GET' && req.url === '/api/health') return json(res, 200, { ok: true, mode: 'work' });
      if (req.method === 'GET' && req.url === '/api/auth/session') { const user = await currentUser(req); return user ? json(res, 200, { user }) : json(res, 401, { error: 'Требуется вход.' }); }
      if (req.method === 'GET' && req.url === '/api/manager/map-config') {
        await requireManager(req);
        const key = typeof yandexMapsApiKey === 'string' ? yandexMapsApiKey.trim() : '';
        return json(res, 200, { provider: 'yandex', enabled: Boolean(key), scriptUrl: key ? `https://api-maps.yandex.ru/v3/?apikey=${encodeURIComponent(key)}&lang=ru_RU` : null });
      }
      if (req.method === 'GET' && url.pathname === '/api/manager/geocode') {
        await requireManager(req);
        const query = url.searchParams.get('q')?.trim();
        if (!query || query.length > 200) return json(res, 400, { error: 'Введите адрес для поиска.' });
        const key = typeof yandexGeocoderApiKey === 'string' ? yandexGeocoderApiKey.trim() : '';
        if (!key) return json(res, 503, { error: 'Поиск адресов не настроен на сервере.' });
        const response = await fetch(`https://geocode-maps.yandex.ru/1.x/?apikey=${encodeURIComponent(key)}&geocode=${encodeURIComponent(query)}&format=json&lang=ru_RU`);
        if (!response.ok) return json(res, 502, { error: 'Яндекс не подтвердил адрес. Попробуйте уточнить запрос.' });
        const payload = await response.json();
        const members = payload.response?.GeoObjectCollection?.featureMember || [];
        const results = members.slice(0, 5).map(({ GeoObject }) => { const position = GeoObject.Point?.pos?.trim().split(/\s+/).map(Number); return position?.length === 2 && position.every(Number.isFinite) ? { address: GeoObject.metaDataProperty?.GeocoderMetaData?.text || GeoObject.name, longitude: position[0], latitude: position[1] } : null; }).filter(Boolean);
        return json(res, 200, results);
      }
      if (req.method === 'POST' && req.url === '/api/auth/login') {
        const input = await readJson(req); const login = cleanLogin(input.login);
        if (!login || typeof input.password !== 'string') return json(res, 400, { error: 'Проверьте логин и пароль.' });
        const user = await db.prepare('SELECT * FROM users WHERE login=?').get(login);
        if (!user || user.status !== 'active' || !passwordMatches(input.password, user.password_hash)) return json(res, 401, { error: 'Неверный логин или пароль.' });
        const token = randomBytes(32).toString('base64url');
        await db.prepare('DELETE FROM work_sessions WHERE expires_at<=?').run(Date.now());
        await db.prepare('INSERT INTO work_sessions VALUES (?, ?, ?, ?)').run(tokenHash(token), user.id, Date.now() + sessionDays * 86400000, new Date().toISOString());
        await audit(user.id, 'login');
        return json(res, 201, { token, user: { id: user.id, login: user.login, role: user.role } });
      }
      if (req.method === 'POST' && req.url === '/api/auth/logout') { const user = await currentUser(req); if (user) { await db.prepare('DELETE FROM work_sessions WHERE token_hash=?').run(tokenHash((req.headers.authorization || '').replace(/^Bearer /, ''))); await audit(user.id, 'logout'); } return json(res, 204, {}); }
      const resource = resourceFor(url.pathname);
      const photoMatch = /^\/api\/manager\/employees\/(\d+)\/photo$/.exec(url.pathname);
      if (photoMatch && req.method === 'GET') {
        await requireManager(req);
        const photo = await db.prepare('SELECT photo_file, photo_mime FROM work_employees WHERE id=?').get(Number(photoMatch[1]));
        if (!photo?.photo_file || !photo.photo_mime) return json(res, 404, { error: 'Фотография не загружена.' });
        res.writeHead(200, { 'Content-Type': photo.photo_mime, 'Cache-Control': 'no-store' });
        return res.end(readFileSync(join(root, 'data', 'employee-photos', photo.photo_file)));
      }
      if (resource && req.method === 'GET') {
        await requireManager(req);
        if (resource.id) {
          const record = await db.prepare(`SELECT * FROM ${resource.table} WHERE id=?`).get(resource.id);
          return record ? json(res, 200, record) : json(res, 404, { error: 'Карточка не найдена.' });
        }
        return json(res, 200, await db.prepare(`SELECT * FROM ${resource.table} ORDER BY updated_at DESC, id DESC`).all());
      }
      if (resource && req.method === 'POST' && !resource.id) {
        const user = await requireManager(req); const { value, photo } = await valueFor(resource, req); const now = new Date().toISOString();
        try {
          const result = await db.prepare(`INSERT INTO ${resource.table} (${resource.fields.join(', ')}, created_at, updated_at) VALUES (${resource.fields.map(() => '?').join(', ')}, ?, ?) RETURNING id`).run(...resource.fields.map(field => value[field]), now, now);
          if (resource.key === 'employees') await db.prepare("INSERT INTO work_employee_access (employee_id, state, created_at, updated_at) VALUES (?, 'pending_activation', ?, ?)").run(result.lastInsertRowid, now, now);
          if (photo) {
            const file = `${randomBytes(18).toString('hex')}.${photo.extension}`;
            const directory = join(root, 'data', 'employee-photos'); mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, file), photo.bytes);
            await db.prepare('UPDATE work_employees SET photo_file=?, photo_mime=?, updated_at=? WHERE id=?').run(file, photo.mime, now, result.lastInsertRowid);
          }
          audit(user.id, `create_${resource.key}`);
          return json(res, 201, await db.prepare(`SELECT * FROM ${resource.table} WHERE id=?`).get(result.lastInsertRowid));
        } catch (error) {
          if (error.message?.includes('UNIQUE constraint failed')) return json(res, 409, { error: resource.key === 'equipment' ? 'Такой инвентарный номер уже есть.' : 'Такая запись уже существует.' });
          throw error;
        }
      }
      if (resource && req.method === 'PUT' && resource.id) {
        const user = await requireManager(req); const { value, photo } = await valueFor(resource, req); const now = new Date().toISOString();
        try {
          const result = await db.prepare(`UPDATE ${resource.table} SET ${resource.fields.map(field => `${field}=?`).join(', ')}, updated_at=? WHERE id=?`).run(...resource.fields.map(field => value[field]), now, resource.id);
          if (!result.changes) return json(res, 404, { error: 'Карточка не найдена.' });
          if (photo) {
            const file = `${randomBytes(18).toString('hex')}.${photo.extension}`;
            const directory = join(root, 'data', 'employee-photos'); mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, file), photo.bytes);
            await db.prepare('UPDATE work_employees SET photo_file=?, photo_mime=?, updated_at=? WHERE id=?').run(file, photo.mime, now, resource.id);
          }
          audit(user.id, `update_${resource.key}`);
          return json(res, 200, await db.prepare(`SELECT * FROM ${resource.table} WHERE id=?`).get(resource.id));
        } catch (error) {
          if (error.message?.includes('UNIQUE constraint failed')) return json(res, 409, { error: 'Такой инвентарный номер уже есть.' });
          throw error;
        }
      }
      return json(res, 404, { error: 'Маршрут не найден.' });
    } catch (error) {
      if (error.status === 401) return json(res, 401, { error: 'Требуется вход.' });
      if (error.status === 403) return json(res, 403, { error: 'Действие доступно только руководителю.' });
      return json(res, error.status || 400, { error: error.message || 'Некорректный запрос.' });
    }
  });
  return { server, db, close: () => new Promise(resolve => server.close(async () => { await db.close(); resolve(); })) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = await createWorkApp({ database: process.env.DATABASE_URL, yandexMapsApiKey: process.env.YANDEX_MAPS_API_KEY, yandexGeocoderApiKey: process.env.YANDEX_GEOCODER_API_KEY, bootstrapAdmin: process.env.BOOTSTRAP_ADMIN_LOGIN ? { login: process.env.BOOTSTRAP_ADMIN_LOGIN, password: process.env.BOOTSTRAP_ADMIN_PASSWORD } : undefined });
  app.server.listen(Number(process.env.PORT || 4174), process.env.HOST || '127.0.0.1');
}
