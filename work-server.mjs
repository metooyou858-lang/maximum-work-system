import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const sessionDays = 7;
const roles = new Set(['manager', 'foreman', 'employee']);

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

export function createWorkApp({ database = join(root, 'data', 'work.sqlite'), bootstrapAdmin } = {}) {
  if (database !== ':memory:') mkdirSync(dirname(database), { recursive: true });
  const db = new DatabaseSync(database);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, login TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('manager','foreman','employee')), status TEXT NOT NULL CHECK(status IN ('active','suspended')), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), event TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  if (bootstrapAdmin && db.prepare('SELECT 1 FROM users LIMIT 1').get() === undefined) {
    const login = cleanLogin(bootstrapAdmin.login);
    if (!login || typeof bootstrapAdmin.password !== 'string' || bootstrapAdmin.password.length < 14) throw new Error('Для первого руководителя нужны логин и пароль не короче 14 символов.');
    db.prepare('INSERT INTO users (login, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?)').run(login, passwordHash(bootstrapAdmin.password), 'manager', 'active', new Date().toISOString());
  }
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const tokenHash = token => scryptSync(token, 'maximum-session-v1', 32).toString('hex');
  const currentUser = req => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const row = db.prepare('SELECT u.id, u.login, u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.status=?').get(tokenHash(token), Date.now(), 'active');
    return row || null;
  };
  const audit = (userId, event) => db.prepare('INSERT INTO audit_log (user_id, event, created_at) VALUES (?, ?, ?)').run(userId, event, new Date().toISOString());
  const readJson = async req => { let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 4096) throw new Error('large'); } try { return JSON.parse(raw || '{}'); } catch { throw new Error('json'); } };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method === 'GET' && req.url === '/api/health') return json(res, 200, { ok: true, mode: 'work' });
      if (req.method === 'GET' && req.url === '/api/auth/session') { const user = currentUser(req); return user ? json(res, 200, { user }) : json(res, 401, { error: 'Требуется вход.' }); }
      if (req.method === 'POST' && req.url === '/api/auth/login') {
        const input = await readJson(req); const login = cleanLogin(input.login);
        if (!login || typeof input.password !== 'string') return json(res, 400, { error: 'Проверьте логин и пароль.' });
        const user = db.prepare('SELECT * FROM users WHERE login=?').get(login);
        if (!user || user.status !== 'active' || !passwordMatches(input.password, user.password_hash)) return json(res, 401, { error: 'Неверный логин или пароль.' });
        const token = randomBytes(32).toString('base64url');
        db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
        db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(tokenHash(token), user.id, Date.now() + sessionDays * 86400000, new Date().toISOString());
        audit(user.id, 'login');
        return json(res, 201, { token, user: { id: user.id, login: user.login, role: user.role } });
      }
      if (req.method === 'POST' && req.url === '/api/auth/logout') { const user = currentUser(req); if (user) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash((req.headers.authorization || '').replace(/^Bearer /, ''))); audit(user.id, 'logout'); } return json(res, 204, {}); }
      return json(res, 404, { error: 'Маршрут не найден.' });
    } catch { return json(res, 400, { error: 'Некорректный запрос.' }); }
  });
  return { server, db, close: () => new Promise(resolve => server.close(() => { db.close(); resolve(); })) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = createWorkApp({ database: process.env.WORK_DATABASE || join(root, 'data', 'work.sqlite'), bootstrapAdmin: process.env.BOOTSTRAP_ADMIN_LOGIN ? { login: process.env.BOOTSTRAP_ADMIN_LOGIN, password: process.env.BOOTSTRAP_ADMIN_PASSWORD } : undefined });
  app.server.listen(Number(process.env.PORT || 4174), process.env.HOST || '127.0.0.1');
}
