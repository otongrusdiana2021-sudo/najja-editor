// Email + password accounts for the editor (VPS mode). Passwords are hashed with scrypt;
// sessions are HMAC-signed cookies bound to a per-user session version (password change logs out everywhere).
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

const SESSION_DAYS = 30;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const httpError = (status, message) => Object.assign(new Error(message), { status });

const scrypt = (pw, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
});
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(pw, salt)).toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const key = await scrypt(pw, Buffer.from(salt, 'base64'));
  const expected = Buffer.from(hash, 'base64');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}
export const normalizeEmail = (e) => String(e || '').trim().toLowerCase();
export function checkPassword(pw) {
  if (String(pw || '').length < 8) throw httpError(400, 'Password minimal 8 karakter.');
  if (String(pw).length > 200) throw httpError(400, 'Password terlalu panjang.');
}

export function createAuth(dataDir) {
  const USERS = path.join(dataDir, 'users.json');
  const KEY = path.join(dataDir, 'session.key');
  let secret = null;
  let cache = null;

  async function key() {
    if (secret) return secret;
    try {
      secret = await fsp.readFile(KEY);
    } catch {
      await fsp.mkdir(dataDir, { recursive: true });
      secret = crypto.randomBytes(32);
      await fsp.writeFile(KEY, secret, { mode: 0o600 });
    }
    return secret;
  }
  async function readUsers() {
    if (cache) return cache;
    try { cache = JSON.parse(await fsp.readFile(USERS, 'utf8')); } catch { cache = []; }
    return cache;
  }
  async function writeUsers(list) {
    await fsp.mkdir(dataDir, { recursive: true });
    const tmp = `${USERS}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, USERS);
    cache = list;
  }
  const publicUser = (u) => ({ email: u.email, role: u.role, createdAt: u.createdAt });

  async function sign(payload) {
    return crypto.createHmac('sha256', await key()).update(payload).digest('base64url');
  }

  return {
    async hasUsers() { return (await readUsers()).length > 0; },

    /** First account; allowed only while no account exists and only with the server token. */
    async setup(email, password, tokenOk) {
      if (await this.hasUsers()) throw httpError(409, 'Akun admin sudah ada. Silakan masuk.');
      if (!tokenOk) throw httpError(401, 'Token server salah.');
      email = normalizeEmail(email);
      if (!EMAIL.test(email)) throw httpError(400, 'Format email tidak valid.');
      checkPassword(password);
      const user = { email, role: 'admin', hash: await hashPassword(password), sv: 1, createdAt: Date.now() };
      await writeUsers([user]);
      return publicUser(user);
    },
    async login(email, password) {
      const user = (await readUsers()).find((u) => u.email === normalizeEmail(email));
      // Always run scrypt so response time doesn't reveal which emails exist.
      const ok = await verifyPassword(password, user?.hash || 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
      if (!user || !ok) throw httpError(401, 'Email atau password salah.');
      return user;
    },
    async createSession(user) {
      const payload = Buffer.from(JSON.stringify({ e: user.email, v: user.sv, x: Date.now() + SESSION_DAYS * 86400_000 })).toString('base64url');
      return `${payload}.${await sign(payload)}`;
    },
    async verifySession(value) {
      const [payload, sig] = String(value || '').split('.');
      if (!payload || !sig) return null;
      const expected = await sign(payload);
      if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
      let data;
      try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
      if (!data || data.x < Date.now()) return null;
      const user = (await readUsers()).find((u) => u.email === data.e);
      return user && user.sv === data.v ? user : null;
    },
    maxAge: SESSION_DAYS * 86400,

    async changePassword(email, current, next) {
      const users = await readUsers();
      const user = users.find((u) => u.email === email);
      if (!user || !(await verifyPassword(current, user.hash))) throw httpError(401, 'Password lama salah.');
      checkPassword(next);
      user.hash = await hashPassword(next);
      user.sv += 1; // logs out every other device
      await writeUsers(users);
      return user;
    },
    async listUsers() { return (await readUsers()).map(publicUser); },
    async addUser(email, password, role = 'editor') {
      email = normalizeEmail(email);
      if (!EMAIL.test(email)) throw httpError(400, 'Format email tidak valid.');
      checkPassword(password);
      const users = await readUsers();
      if (users.some((u) => u.email === email)) throw httpError(409, 'Email ini sudah terdaftar.');
      const user = { email, role: role === 'admin' ? 'admin' : 'editor', hash: await hashPassword(password), sv: 1, createdAt: Date.now() };
      await writeUsers([...users, user]);
      return publicUser(user);
    },
    async removeUser(email, actingEmail) {
      email = normalizeEmail(email);
      if (email === actingEmail) throw httpError(400, 'Tidak bisa menghapus akun sendiri.');
      const users = await readUsers();
      if (!users.some((u) => u.email === email)) throw httpError(404, 'Pengguna tidak ditemukan.');
      await writeUsers(users.filter((u) => u.email !== email));
      return { ok: true };
    },
    /** Remove every account and session key: the next visit shows first-time setup again. */
    async reset() {
      await fsp.rm(USERS, { force: true });
      await fsp.rm(KEY, { force: true });
      cache = null;
      secret = null;
    },
  };
}
