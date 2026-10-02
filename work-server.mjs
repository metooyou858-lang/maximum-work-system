import http from 'node:http';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresDatabase } from './postgres-db.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const sessionDays = 7;
const permissions = new Set(['manage_employees', 'manage_objects', 'manage_equipment', 'manage_settings', 'manage_assignments', 'employee_cabinet']);
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
    CREATE TABLE IF NOT EXISTS users (id BIGSERIAL PRIMARY KEY, login TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('administrator','employee')), status TEXT NOT NULL CHECK(status IN ('active','suspended')), employee_id BIGINT UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_sessions (token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id), expires_at BIGINT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_log (id BIGSERIAL PRIMARY KEY, user_id BIGINT REFERENCES users(id), event TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_objects (id BIGSERIAL PRIMARY KEY, contractor_name TEXT NOT NULL DEFAULT '', address TEXT NOT NULL UNIQUE, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, radius INTEGER, address_verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_employees (id BIGSERIAL PRIMARY KEY, full_name TEXT NOT NULL, position TEXT NOT NULL DEFAULT '', email TEXT NOT NULL UNIQUE, phone TEXT NOT NULL, birth_date TEXT NOT NULL, clothing_size TEXT NOT NULL, shoe_size TEXT NOT NULL, photo_file TEXT, photo_mime TEXT, privacy_policy_version TEXT NOT NULL, privacy_confirmed_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_equipment (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, inventory_number TEXT NOT NULL UNIQUE, equipment_type TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_employee_access (employee_id BIGINT PRIMARY KEY REFERENCES work_employees(id), user_id BIGINT UNIQUE REFERENCES users(id), state TEXT NOT NULL CHECK(state IN ('pending_activation','active','suspended')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS user_permissions (user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, permission TEXT NOT NULL, PRIMARY KEY (user_id, permission));
  `);
  await db.exec('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check');
  await db.exec('ALTER TABLE user_permissions DROP CONSTRAINT IF EXISTS user_permissions_permission_check');
  await db.exec("DELETE FROM user_permissions WHERE permission IN ('manage_registry', 'manage_access')");
  await db.exec("ALTER TABLE user_permissions ADD CONSTRAINT user_permissions_permission_check CHECK (permission IN ('manage_employees','manage_objects','manage_equipment','manage_settings','manage_assignments','employee_cabinet'))");
  const hasColumn = async (table, column) => (await db.prepare('SELECT column_name FROM information_schema.columns WHERE table_name=? AND column_name=?').all(table, column)).length > 0;
  if (!await hasColumn('work_employee_access', 'activation_token_hash')) await db.exec('ALTER TABLE work_employee_access ADD COLUMN activation_token_hash TEXT');
  if (!await hasColumn('work_employee_access', 'activation_expires_at')) await db.exec('ALTER TABLE work_employee_access ADD COLUMN activation_expires_at BIGINT');
  if (!await hasColumn('work_employee_access', 'permissions')) await db.exec("ALTER TABLE work_employee_access ADD COLUMN permissions TEXT[] NOT NULL DEFAULT ARRAY['employee_cabinet']::TEXT[]");
  if (!await hasColumn('work_employees', 'position')) await db.exec("ALTER TABLE work_employees ADD COLUMN position TEXT NOT NULL DEFAULT ''");
  for (const table of ['users', 'audit_log', 'work_objects', 'work_employees', 'work_equipment']) {
    const sequence = `${table}_id_seq`;
    await db.exec(`CREATE SEQUENCE IF NOT EXISTS ${sequence}; ALTER SEQUENCE ${sequence} OWNED BY ${table}.id; ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT nextval('${sequence}'); SELECT setval('${sequence}', COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM ${table};`);
  }
  await db.exec("INSERT INTO user_permissions (user_id, permission) SELECT id, permission FROM users CROSS JOIN unnest(ARRAY['manage_employees','manage_objects','manage_equipment','manage_settings','manage_assignments','employee_cabinet']) AS permission WHERE role='administrator' ON CONFLICT DO NOTHING; INSERT INTO user_permissions (user_id, permission) SELECT id, permission FROM users CROSS JOIN unnest(ARRAY['manage_employees','manage_objects','manage_equipment','employee_cabinet']) AS permission WHERE role IN ('manager','foreman') ON CONFLICT DO NOTHING; UPDATE users SET role='employee' WHERE role IN ('administrator','manager','foreman'); ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role='employee')");
  if (bootstrapAdmin && await db.prepare('SELECT 1 FROM users LIMIT 1').get() === undefined) {
    const login = cleanLogin(bootstrapAdmin.login);
    if (!login || typeof bootstrapAdmin.password !== 'string' || bootstrapAdmin.password.length < 14) throw new Error('Для первого руководителя нужны логин и пароль не короче 14 символов.');
    await db.prepare('INSERT INTO users (login, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id').run(login, passwordHash(bootstrapAdmin.password), 'employee', 'active', new Date().toISOString());
  }
  if (bootstrapAdmin && cleanLogin(bootstrapAdmin.login)) await db.exec(`INSERT INTO user_permissions (user_id, permission) SELECT id, permission FROM users CROSS JOIN unnest(ARRAY['manage_employees','manage_objects','manage_equipment','manage_settings','manage_assignments','employee_cabinet']) AS permission WHERE login='${cleanLogin(bootstrapAdmin.login)}' ON CONFLICT DO NOTHING`);
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const tokenHash = token => scryptSync(token, 'maximum-session-v1', 32).toString('hex');
  const activationTokenHash = token => scryptSync(token, 'maximum-activation-v1', 32).toString('hex');
  const currentUser = async req => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const row = await db.prepare("SELECT u.id, u.login, u.role, COALESCE(array_agg(p.permission) FILTER (WHERE p.permission IS NOT NULL), '{}') AS permissions FROM work_sessions s JOIN users u ON u.id=s.user_id LEFT JOIN user_permissions p ON p.user_id=u.id WHERE s.token_hash=? AND s.expires_at>? AND u.status=? GROUP BY u.id").get(tokenHash(token), Date.now(), 'active');
    return row || null;
  };
  const audit = (userId, event) => db.prepare('INSERT INTO audit_log (user_id, event, created_at) VALUES (?, ?, ?)').run(userId, event, new Date().toISOString());
  const readJson = async req => { let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 7 * 1024 * 1024) throw new Error('Файл слишком большой. Выберите фотографию до 5 МБ.'); } try { return JSON.parse(raw || '{}'); } catch { throw new Error('Не удалось прочитать запрос.'); } };
  const requirePermission = permission => async req => {
    const user = await currentUser(req);
    if (!user) { const error = new Error('auth'); error.status = 401; throw error; }
    if (!user.permissions.includes(permission)) { const error = new Error('role'); error.status = 403; throw error; }
    return user;
  };
  const requireManager = requirePermission('manage_employees');
  const requireEmployee = async req => {
    const user = await currentUser(req);
    if (!user) { const error = new Error('auth'); error.status = 401; throw error; }
    if (user.role !== 'employee') { const error = new Error('role'); error.status = 403; throw error; }
    return user;
  };
  const mailSettingsPath = join(root, 'data', 'mail-settings.json');
  const mailSettingsKey = /^[0-9a-f]{64}$/i.test(process.env.MAIL_SETTINGS_KEY || '') ? Buffer.from(process.env.MAIL_SETTINGS_KEY, 'hex') : null;
  const readMailSettings = () => { if (!mailSettingsKey) return null; try { const payload = JSON.parse(readFileSync(mailSettingsPath, 'utf8')); const decipher = createDecipheriv('aes-256-gcm', mailSettingsKey, Buffer.from(payload.iv, 'hex')); decipher.setAuthTag(Buffer.from(payload.tag, 'hex')); return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload.data, 'hex')), decipher.final()]).toString('utf8')); } catch { return null; } };
  const writeMailSettings = settings => { if (!mailSettingsKey) return false; const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', mailSettingsKey, iv); const data = Buffer.concat([cipher.update(JSON.stringify(settings), 'utf8'), cipher.final()]); mkdirSync(dirname(mailSettingsPath), { recursive: true }); writeFileSync(mailSettingsPath, JSON.stringify({ iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') }), { mode: 0o600 }); return true; };
  const text = (value, label) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) { const error = new Error(`Проверьте поле «${label}».`); error.status = 400; throw error; }
    return value.trim();
  };
  const resources = {
    objects: { table: 'work_objects', fields: ['contractor_name', 'address', 'latitude', 'longitude', 'radius', 'address_verified'], labels: { contractor_name: 'Наименование подрядчика', address: 'Адрес объекта', latitude: 'Широта', longitude: 'Долгота', radius: 'Радиус объекта' } },
    employees: { table: 'work_employees', permission: 'manage_employees', fields: ['full_name', 'position', 'email', 'phone', 'birth_date', 'clothing_size', 'shoe_size', 'privacy_policy_version', 'privacy_confirmed_at'], labels: { full_name: 'ФИО', position: 'Должность', email: 'Личный email', phone: 'Телефон', birth_date: 'Дата рождения', clothing_size: 'Размер одежды', shoe_size: 'Размер обуви', privacy_confirmed_at: 'Подтверждение политики' } },
    equipment: { table: 'work_equipment', permission: 'manage_equipment', fields: ['name', 'inventory_number', 'equipment_type'], labels: { name: 'Название', inventory_number: 'Инвентарный номер', equipment_type: 'Тип оборудования' } },
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
    if (!input || Object.keys(input).some(key => !writable.includes(key) && key !== 'photo_data' && !(resource.key === 'employees' && key === 'permissions'))) { const error = new Error('В карточке есть неподдерживаемые поля.'); error.status = 400; throw error; }
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
    const grantedPermissions = resource.key === 'employees' ? (Array.isArray(input.permissions) ? input.permissions : []).filter(permission => permissions.has(permission)) : [];
    if (resource.key === 'employees' && (!Array.isArray(input.permissions) || grantedPermissions.length !== input.permissions.length)) { const error = new Error('Проверьте выбранные права доступа.'); error.status = 400; throw error; }
    return { value, photo, grantedPermissions };
  };
  const assets = {
    '/': ['work-cabinet.html', 'text/html; charset=utf-8'],
    '/work-cabinet.js': ['work-cabinet.js', 'text/javascript; charset=utf-8'],
    '/work-cabinet.css': ['work-cabinet.css', 'text/css; charset=utf-8'],
    '/manager/': ['work-cabinet.html', 'text/html; charset=utf-8'],
    '/manager/work-cabinet.js': ['work-cabinet.js', 'text/javascript; charset=utf-8'],
    '/manager/work-cabinet.css': ['work-cabinet.css', 'text/css; charset=utf-8'],
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
        await requirePermission('manage_objects')(req);
        const key = typeof yandexMapsApiKey === 'string' ? yandexMapsApiKey.trim() : '';
        return json(res, 200, { provider: 'yandex', enabled: Boolean(key), scriptUrl: key ? `https://api-maps.yandex.ru/v3/?apikey=${encodeURIComponent(key)}&lang=ru_RU` : null });
      }
      if (req.method === 'GET' && url.pathname === '/api/manager/geocode') {
        await requirePermission('manage_objects')(req);
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
        const sessionUser = await currentUser({ headers: { authorization: `Bearer ${token}` } });
        return json(res, 201, { token, user: sessionUser });
      }
      if (req.method === 'POST' && req.url === '/api/auth/activate') {
        const input = await readJson(req); const login = cleanLogin(input.login);
        if (typeof input.token !== 'string' || !login || typeof input.password !== 'string' || input.password.length < 14) return json(res, 400, { error: 'Проверьте ссылку приглашения, логин и пароль не короче 14 символов.' });
        const access = await db.prepare("SELECT a.employee_id FROM work_employee_access a WHERE a.activation_token_hash=? AND a.activation_expires_at>? AND a.state='pending_activation'").get(activationTokenHash(input.token), Date.now());
        if (!access) return json(res, 400, { error: 'Ссылка приглашения недействительна или истекла. Обратитесь к руководителю за новой.' });
        const now = new Date().toISOString();
        try {
          const created = await db.prepare('INSERT INTO users (login, password_hash, role, status, employee_id, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id').run(login, passwordHash(input.password), 'employee', 'active', access.employee_id, now);
          await db.prepare("INSERT INTO user_permissions (user_id, permission) SELECT ?, permission FROM unnest((SELECT permissions FROM work_employee_access WHERE employee_id=?)) AS permission ON CONFLICT DO NOTHING").run(created.lastInsertRowid, access.employee_id);
          await db.prepare("UPDATE work_employee_access SET user_id=?, state='active', activation_token_hash=NULL, activation_expires_at=NULL, updated_at=? WHERE employee_id=?").run(created.lastInsertRowid, now, access.employee_id);
          await audit(created.lastInsertRowid, 'activate_employee');
          return json(res, 201, { user: { id: created.lastInsertRowid, login, role: 'employee' } });
        } catch (error) {
          if (error.code === '23505') return json(res, 409, { error: 'Такой логин уже занят.' });
          throw error;
        }
      }
      if (req.method === 'POST' && req.url === '/api/auth/logout') { const user = await currentUser(req); if (user) { await db.prepare('DELETE FROM work_sessions WHERE token_hash=?').run(tokenHash((req.headers.authorization || '').replace(/^Bearer /, ''))); await audit(user.id, 'logout'); } return json(res, 204, {}); }
      if (req.method === 'GET' && req.url === '/api/employee/profile') {
        const employee = await requireEmployee(req);
        const profile = await db.prepare('SELECT e.* FROM work_employees e JOIN users u ON u.employee_id=e.id WHERE u.id=?').get(employee.id);
        return profile ? json(res, 200, profile) : json(res, 404, { error: 'Карточка сотрудника не найдена.' });
      }
      if (req.method === 'GET' && req.url === '/api/manager/settings') {
        await requirePermission('manage_settings')(req); const email = readMailSettings();
        return json(res, 200, { email: email ? { configured: true, host: email.host, port: email.port, username: email.username, sender: email.sender, password_configured: true } : { configured: false, storage_ready: Boolean(mailSettingsKey) } });
      }
      if (req.method === 'PUT' && req.url === '/api/manager/settings/email') {
        const administrator = await requirePermission('manage_settings')(req); const input = await readJson(req);
        if (!mailSettingsKey) return json(res, 503, { error: 'Защищённое хранилище почтовых настроек ещё не подготовлено.' });
        const host = text(input.host, 'SMTP-сервер'); const username = text(input.username, 'Логин SMTP'); const sender = text(input.sender, 'Адрес отправителя'); const port = Number(input.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof input.password !== 'string' || !input.password) return json(res, 400, { error: 'Проверьте порт и пароль SMTP.' });
        writeMailSettings({ host, port, username, sender, password: input.password, secure: input.secure === true }); await audit(administrator.id, 'configure_email');
        return json(res, 200, { configured: true, host, port, username, sender, password_configured: true });
      }
      const invitationMatch = /^\/api\/manager\/employees\/(\d+)\/invitation$/.exec(url.pathname);
      if (invitationMatch && req.method === 'POST') {
        const manager = await requirePermission('manage_employees')(req); const employeeId = Number(invitationMatch[1]);
        const access = await db.prepare('SELECT state FROM work_employee_access WHERE employee_id=?').get(employeeId);
        if (!access) return json(res, 404, { error: 'Карточка сотрудника не найдена.' });
        if (access.state === 'active') return json(res, 409, { error: 'Учётная запись сотрудника уже активирована.' });
        const token = randomBytes(32).toString('base64url'); const now = new Date().toISOString();
        await db.prepare("UPDATE work_employee_access SET state='pending_activation', activation_token_hash=?, activation_expires_at=?, updated_at=? WHERE employee_id=?").run(activationTokenHash(token), Date.now() + 7 * 86400000, now, employeeId);
        await audit(manager.id, 'create_employee_invitation');
        return json(res, 201, { activation_path: `/#activate=${token}`, expires_at: new Date(Date.now() + 7 * 86400000).toISOString() });
      }
      const resource = resourceFor(url.pathname);
      const photoMatch = /^\/api\/manager\/employees\/(\d+)\/photo$/.exec(url.pathname);
      if (photoMatch && req.method === 'GET') {
        await requirePermission('manage_employees')(req);
        const photo = await db.prepare('SELECT photo_file, photo_mime FROM work_employees WHERE id=?').get(Number(photoMatch[1]));
        if (!photo?.photo_file || !photo.photo_mime) return json(res, 404, { error: 'Фотография не загружена.' });
        res.writeHead(200, { 'Content-Type': photo.photo_mime, 'Cache-Control': 'no-store' });
        return res.end(readFileSync(join(root, 'data', 'employee-photos', photo.photo_file)));
      }
      if (resource && req.method === 'GET') {
        await requirePermission(resource.permission || 'manage_objects')(req);
        if (resource.id) {
          const record = resource.key === 'employees'
            ? await db.prepare('SELECT e.*, a.state AS access_state, a.permissions FROM work_employees e JOIN work_employee_access a ON a.employee_id=e.id WHERE e.id=?').get(resource.id)
            : await db.prepare(`SELECT * FROM ${resource.table} WHERE id=?`).get(resource.id);
          return record ? json(res, 200, record) : json(res, 404, { error: 'Карточка не найдена.' });
        }
        return json(res, 200, resource.key === 'employees'
          ? await db.prepare('SELECT e.*, a.state AS access_state, a.permissions FROM work_employees e JOIN work_employee_access a ON a.employee_id=e.id ORDER BY e.updated_at DESC, e.id DESC').all()
          : await db.prepare(`SELECT * FROM ${resource.table} ORDER BY updated_at DESC, id DESC`).all());
      }
      if (resource && req.method === 'POST' && !resource.id) {
        const user = await requirePermission(resource.permission || 'manage_objects')(req); const { value, photo, grantedPermissions } = await valueFor(resource, req); const now = new Date().toISOString();
        try {
          const result = await db.prepare(`INSERT INTO ${resource.table} (${resource.fields.join(', ')}, created_at, updated_at) VALUES (${resource.fields.map(() => '?').join(', ')}, ?, ?) RETURNING id`).run(...resource.fields.map(field => value[field]), now, now);
          if (resource.key === 'employees') await db.prepare("INSERT INTO work_employee_access (employee_id, state, permissions, created_at, updated_at) VALUES (?, 'pending_activation', ?, ?, ?)").run(result.lastInsertRowid, grantedPermissions, now, now);
          if (photo) {
            const file = `${randomBytes(18).toString('hex')}.${photo.extension}`;
            const directory = join(root, 'data', 'employee-photos'); mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, file), photo.bytes);
            await db.prepare('UPDATE work_employees SET photo_file=?, photo_mime=?, updated_at=? WHERE id=?').run(file, photo.mime, now, result.lastInsertRowid);
          }
          audit(user.id, `create_${resource.key}`);
          return json(res, 201, await db.prepare(`SELECT * FROM ${resource.table} WHERE id=?`).get(result.lastInsertRowid));
        } catch (error) {
          if (error.code === '23505') return json(res, 409, { error: resource.key === 'equipment' ? 'Такой инвентарный номер уже есть.' : 'Такая запись уже существует.' });
          throw error;
        }
      }
      if (resource && req.method === 'PUT' && resource.id) {
        const user = await requirePermission(resource.permission || 'manage_objects')(req); const { value, photo, grantedPermissions } = await valueFor(resource, req); const now = new Date().toISOString();
        try {
          const result = await db.prepare(`UPDATE ${resource.table} SET ${resource.fields.map(field => `${field}=?`).join(', ')}, updated_at=? WHERE id=?`).run(...resource.fields.map(field => value[field]), now, resource.id);
          if (!result.changes) return json(res, 404, { error: 'Карточка не найдена.' });
          if (resource.key === 'employees') await db.prepare('UPDATE work_employee_access SET permissions=?, updated_at=? WHERE employee_id=?').run(grantedPermissions, now, resource.id);
          if (photo) {
            const file = `${randomBytes(18).toString('hex')}.${photo.extension}`;
            const directory = join(root, 'data', 'employee-photos'); mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, file), photo.bytes);
            await db.prepare('UPDATE work_employees SET photo_file=?, photo_mime=?, updated_at=? WHERE id=?').run(file, photo.mime, now, resource.id);
          }
          audit(user.id, `update_${resource.key}`);
          return json(res, 200, await db.prepare(`SELECT * FROM ${resource.table} WHERE id=?`).get(resource.id));
        } catch (error) {
          if (error.code === '23505') return json(res, 409, { error: 'Такой инвентарный номер уже есть.' });
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
