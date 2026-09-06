import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { db, getItemBySlug, getSettings, publicItem } from './db.js';

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET || 'development-only-session-secret';

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser(sessionSecret));
app.use(rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: true, legacyHeaders: false }));

const sessionCookie = {
  httpOnly: true,
  sameSite: 'lax',
  secure: isProduction,
  signed: true,
  maxAge: 1000 * 60 * 60 * 24 * 30
};

function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createSession(userId, state = null) {
  const token = createToken();
  db.prepare("INSERT INTO sessions (token, user_id, state, expires_at) VALUES (?, ?, ?, datetime('now', '+30 days'))").run(token, userId, state);
  return token;
}

function currentUser(req) {
  const token = req.signedCookies.bv_session;
  if (!token) return null;
  const session = db.prepare(`
    SELECT sessions.token, sessions.expires_at, users.id, users.discord_id, users.username, users.avatar, users.role
    FROM sessions LEFT JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ? AND sessions.expires_at > datetime('now')
  `).get(token);
  return session?.id ? session : null;
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required.' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const user = currentUser(req);
  if (!user || !['ADMIN', 'OWNER'].includes(user.role)) return res.status(403).json({ error: 'You do not have permission to access this area.' });
  req.user = user;
  next();
}

function requireOwner(req, res, next) {
  const user = currentUser(req);
  if (!user || user.role !== 'OWNER') return res.status(403).json({ error: 'Owner access is required.' });
  req.user = user;
  next();
}

function cleanSlug(value) {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function validateItem(payload) {
  const name = String(payload.name || '').trim();
  const slug = cleanSlug(payload.slug || name);
  const value = Number(payload.value);
  const demand = Number(payload.demand);
  if (!name || !slug || !Number.isFinite(value) || value < 0 || !Number.isFinite(demand) || demand < 1 || demand > 10) {
    return { error: 'Name, value, and a demand rating from 1 to 10 are required.' };
  }
  return {
    name,
    slug,
    image_url: String(payload.image_url || '').trim().slice(0, 1000),
    category_id: Number(payload.category_id),
    value: Math.round(value),
    demand: Math.round(demand * 10) / 10,
    description: String(payload.description || '').trim().slice(0, 2000)
  };
}

app.get('/api/session', (req, res) => {
  const user = currentUser(req);
  res.json({
    user: user ? { id: user.id, discord_id: user.discord_id, username: user.username, avatar: user.avatar, role: user.role } : null,
    discordConfigured: Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET),
    demoAdminEnabled: process.env.DEMO_ADMIN === 'true'
  });
});

app.get('/api/categories', (_req, res) => {
  res.json(db.prepare('SELECT id, name, slug FROM categories ORDER BY name').all());
});

app.get('/api/settings', (_req, res) => {
  const settings = getSettings();
  res.json({
    website_name: settings.website_name,
    website_description: settings.website_description,
    discord_server_url: settings.discord_server_url
  });
});

app.get('/api/items', (req, res) => {
  const search = String(req.query.search || '').trim();
  const category = String(req.query.category || '').trim();
  const sortMap = { value: 'items.value DESC', demand: 'items.demand DESC', name: 'items.name ASC', updated: 'items.updated_at DESC' };
  const sort = sortMap[req.query.sort] || sortMap.updated;
  const where = [];
  const params = [];
  if (search) {
    where.push('(items.name LIKE ? OR items.description LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  if (category) {
    where.push('categories.slug = ?');
    params.push(category);
  }
  const sql = `
    SELECT items.*, categories.name AS category, categories.slug AS category_slug
    FROM items JOIN categories ON categories.id = items.category_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${sort}
  `;
  res.json(db.prepare(sql).all(...params).map(publicItem));
});

app.get('/api/items/:slug', (req, res) => {
  const item = getItemBySlug(req.params.slug);
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  const history = db.prepare(`
    SELECT old_value, new_value, old_demand, new_demand, created_at
    FROM value_history WHERE item_id = ? ORDER BY created_at DESC LIMIT 12
  `).all(item.id);
  res.json({ item: publicItem(item), history });
});

app.get('/api/admin/overview', requireAdmin, (_req, res) => {
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM items) AS items,
      (SELECT COUNT(*) FROM items JOIN categories ON categories.id = items.category_id WHERE categories.slug = 'fruits') AS fruits,
      (SELECT COUNT(*) FROM items JOIN categories ON categories.id = items.category_id WHERE categories.slug = 'gamepasses') AS gamepasses,
      (SELECT COUNT(*) FROM items JOIN categories ON categories.id = items.category_id WHERE categories.slug = 'limited') AS limited,
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM users WHERE role IN ('ADMIN', 'OWNER')) AS admins
  `).get();
  const recent = db.prepare(`
    SELECT value_history.*, items.name AS item_name, users.username AS changed_by_name
    FROM value_history JOIN items ON items.id = value_history.item_id
    LEFT JOIN users ON users.id = value_history.changed_by
    ORDER BY value_history.created_at DESC LIMIT 8
  `).all();
  res.json({ counts, recent });
});

app.get('/api/admin/items', requireAdmin, (_req, res) => {
  res.json(db.prepare(`
    SELECT items.*, categories.name AS category, categories.slug AS category_slug
    FROM items JOIN categories ON categories.id = items.category_id ORDER BY items.name
  `).all().map(publicItem));
});

app.post('/api/admin/items', requireAdmin, (req, res) => {
  const item = validateItem(req.body);
  if (item.error) return res.status(400).json({ error: item.error });
  const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(item.category_id);
  if (!category) return res.status(400).json({ error: 'Choose a valid category.' });
  try {
    const result = db.prepare(`
      INSERT INTO items (name, slug, image_url, category_id, value, demand, description)
      VALUES (@name, @slug, @image_url, @category_id, @value, @demand, @description)
    `).run(item);
    res.status(201).json({ item: publicItem(getItemBySlug(item.slug)), message: 'Item added.' });
  } catch {
    res.status(409).json({ error: 'An item with that slug already exists.' });
  }
});

app.put('/api/admin/items/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Item not found.' });
  const item = validateItem(req.body);
  if (item.error) return res.status(400).json({ error: item.error });
  if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(item.category_id)) return res.status(400).json({ error: 'Choose a valid category.' });
  try {
    const update = db.transaction(() => {
      db.prepare(`
        UPDATE items SET name=@name, slug=@slug, image_url=@image_url, category_id=@category_id,
        value=@value, demand=@demand, description=@description, updated_at=CURRENT_TIMESTAMP WHERE id=@id
      `).run({ ...item, id: req.params.id });
      if (existing.value !== item.value || existing.demand !== item.demand) {
        db.prepare(`
          INSERT INTO value_history (item_id, old_value, new_value, old_demand, new_demand, changed_by)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(existing.id, existing.value, item.value, existing.demand, item.demand, req.user.id);
      }
    });
    update();
    res.json({ item: publicItem(getItemBySlug(item.slug)), message: `${item.name} updated successfully.` });
  } catch {
    res.status(409).json({ error: 'An item with that slug already exists.' });
  }
});

app.delete('/api/admin/items/:id', requireAdmin, (req, res) => {
  const item = db.prepare('SELECT id, name FROM items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  db.prepare('DELETE FROM items WHERE id = ?').run(item.id);
  res.json({ message: `${item.name} deleted.` });
});

app.get('/api/admin/categories', requireAdmin, (_req, res) => {
  res.json(db.prepare(`
    SELECT categories.*, COUNT(items.id) AS item_count
    FROM categories LEFT JOIN items ON items.category_id = categories.id
    GROUP BY categories.id ORDER BY categories.name
  `).all());
});

app.post('/api/admin/categories', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  const slug = cleanSlug(name);
  if (!name || !slug) return res.status(400).json({ error: 'Category name is required.' });
  try {
    db.prepare('INSERT INTO categories (name, slug) VALUES (?, ?)').run(name, slug);
    res.status(201).json({ message: 'Category created.' });
  } catch {
    res.status(409).json({ error: 'That category already exists.' });
  }
});

app.delete('/api/admin/categories/:id', requireAdmin, (req, res) => {
  const category = db.prepare('SELECT id, name FROM categories WHERE id = ?').get(req.params.id);
  if (!category) return res.status(404).json({ error: 'Category not found.' });
  const count = db.prepare('SELECT COUNT(*) AS count FROM items WHERE category_id = ?').get(category.id).count;
  if (count) return res.status(400).json({ error: 'Move or delete the items in this category first.' });
  db.prepare('DELETE FROM categories WHERE id = ?').run(category.id);
  res.json({ message: 'Category deleted.' });
});

app.get('/api/admin/admins', requireOwner, (_req, res) => {
  res.json(db.prepare(`SELECT id, discord_id, username, avatar, role, created_at FROM users WHERE role IN ('ADMIN', 'OWNER') ORDER BY role DESC, username`).all());
});

app.post('/api/admin/admins', requireOwner, (req, res) => {
  const discordId = String(req.body.discord_id || '').trim();
  if (!/^\d{5,25}$/.test(discordId)) return res.status(400).json({ error: 'Enter a valid Discord user ID.' });
  const user = db.prepare('SELECT id, username FROM users WHERE discord_id = ?').get(discordId);
  if (!user) return res.status(404).json({ error: 'That user must log in with Discord before becoming an admin.' });
  db.prepare('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('ADMIN', user.id);
  res.json({ message: `${user.username} is now an administrator.` });
});

app.delete('/api/admin/admins/:id', requireOwner, (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'You cannot remove yourself.' });
  db.prepare(`UPDATE users SET role = 'USER', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND role = 'ADMIN'`).run(req.params.id);
  res.json({ message: 'Administrator access removed.' });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const allowed = ['website_name', 'website_description', 'discord_server_url', 'fair_percentage', 'win_percentage', 'big_win_percentage', 'loss_percentage', 'big_loss_percentage', 'demand_weight'];
  const update = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const transaction = db.transaction(() => {
    for (const key of allowed) if (req.body[key] !== undefined) update.run(key, String(req.body[key]).trim());
  });
  transaction();
  res.json({ message: 'Settings saved.', settings: getSettings() });
});

app.get('/api/auth/discord', (req, res) => {
  if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) return res.redirect('/?auth=not-configured');
  const state = createToken();
  const sessionToken = createSession(null, state);
  res.cookie('bv_oauth', state, { ...sessionCookie, maxAge: 10 * 60 * 1000 });
  res.cookie('bv_session', sessionToken, { ...sessionCookie, maxAge: 10 * 60 * 1000 });
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
    state
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/api/auth/discord/callback', async (req, res) => {
  const state = String(req.query.state || '');
  const oauthState = req.signedCookies.bv_oauth;
  const sessionToken = req.signedCookies.bv_session;
  const oauthSession = sessionToken && db.prepare(`SELECT * FROM sessions WHERE token = ? AND state = ? AND expires_at > datetime('now')`).get(sessionToken, state);
  if (!state || state !== oauthState || !oauthSession) return res.redirect('/?auth=invalid-state');
  try {
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: String(req.query.code || ''),
        redirect_uri: process.env.DISCORD_REDIRECT_URI
      })
    });
    if (!tokenResponse.ok) throw new Error('Discord token exchange failed');
    const token = await tokenResponse.json();
    const profileResponse = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!profileResponse.ok) throw new Error('Discord profile request failed');
    const profile = await profileResponse.json();
    const role = process.env.OWNER_DISCORD_ID && profile.id === process.env.OWNER_DISCORD_ID ? 'OWNER' : 'USER';
    const existing = db.prepare('SELECT id, role FROM users WHERE discord_id = ?').get(profile.id);
    let userId;
    if (existing) {
      userId = existing.id;
      if (role === 'OWNER' && existing.role !== 'OWNER') db.prepare(`UPDATE users SET role='OWNER', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(userId);
      db.prepare('UPDATE users SET username=?, avatar=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(profile.username, profile.avatar || '', userId);
    } else {
      userId = db.prepare('INSERT INTO users (discord_id, username, avatar, role) VALUES (?, ?, ?, ?)').run(profile.id, profile.username, profile.avatar || '', role).lastInsertRowid;
    }
    db.prepare("UPDATE sessions SET user_id = ?, state = NULL, expires_at = datetime('now', '+30 days') WHERE token = ?").run(userId, sessionToken);
    res.clearCookie('bv_oauth');
    res.cookie('bv_session', sessionToken, sessionCookie);
    res.redirect('/?auth=success');
  } catch {
    res.redirect('/?auth=error');
  }
});

app.get('/api/demo-login', (req, res) => {
  if (process.env.DEMO_ADMIN !== 'true') return res.status(404).json({ error: 'Not found.' });
  let user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get('demo-owner');
  if (!user) {
    const id = db.prepare(`INSERT INTO users (discord_id, username, avatar, role) VALUES ('demo-owner', 'Demo Owner', '', 'OWNER')`).run().lastInsertRowid;
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }
  const token = createSession(user.id);
  res.cookie('bv_session', token, sessionCookie);
  res.redirect('/');
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.signedCookies.bv_session;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie('bv_session');
  res.json({ message: 'Signed out.' });
});

app.use(express.static(path.join(process.cwd(), 'public'), { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(path.join(process.cwd(), 'public', 'index.html')));

app.listen(port, () => {
  console.log(`BloxValues running on http://localhost:${port}`);
});