import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

const databasePath = process.env.DATABASE_PATH || './data/bloxvalues.db';
const resolvedPath = path.resolve(databasePath);
fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

export const db = new Database(resolvedPath);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

export const defaultSettings = {
  website_name: 'BloxValues',
  website_description: 'A clean, community-first market board for smarter Blox Fruits trades.',
  discord_server_url: process.env.DISCORD_SERVER_URL || 'https://discord.gg/your-server',
  fair_percentage: '5',
  win_percentage: '12',
  big_win_percentage: '25',
  loss_percentage: '-5',
  big_loss_percentage: '-25',
  demand_weight: '0.35'
};

function slugify(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export function seedDatabase() {
  const categoryCount = db.prepare('SELECT COUNT(*) AS count FROM categories').get().count;
  if (!categoryCount) {
    const insert = db.prepare('INSERT INTO categories (name, slug) VALUES (?, ?)');
    for (const name of ['Fruits', 'Gamepasses', 'Limited']) insert.run(name, slugify(name));
  }

  const itemCount = db.prepare('SELECT COUNT(*) AS count FROM items').get().count;
  if (!itemCount) {
    const categories = Object.fromEntries(db.prepare('SELECT id, slug FROM categories').all().map((row) => [row.slug, row.id]));
    const items = [
      ['Dragon', 'dragon', 'https://images.unsplash.com/photo-1553279768-865429fa0078?auto=format&fit=crop&w=900&q=80', 'fruits', 15000, 9, 'A premium mythical fruit with exceptional demand and strong trade liquidity.'],
      ['Leopard', 'leopard', 'https://images.unsplash.com/photo-1533738363-b7f9aef128ce?auto=format&fit=crop&w=900&q=80', 'fruits', 22000, 10, 'High-demand mythical fruit that stays near the top of most trade lists.'],
      ['Portal', 'portal', 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=900&q=80', 'fruits', 8000, 8, 'A popular mobility fruit with dependable demand across trading servers.'],
      ['Dough', 'dough', 'https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&w=900&q=80', 'fruits', 18000, 9, 'A sought-after fruit with strong demand and an active trading market.'],
      ['2x Money', '2x-money', 'https://images.unsplash.com/photo-1559526324-593bc073d938?auto=format&fit=crop&w=900&q=80', 'gamepasses', 45000, 8, 'Permanent gamepass. Sample value only — replace with your community values.'],
      ['Fast Boats', 'fast-boats', 'https://images.unsplash.com/photo-1500375592092-40eb2168fd21?auto=format&fit=crop&w=900&q=80', 'gamepasses', 25000, 7, 'Permanent gamepass with steady demand from collectors and grinders.'],
      ['Party Hat', 'party-hat', 'https://images.unsplash.com/photo-1513151233558-d860c5398176?auto=format&fit=crop&w=900&q=80', 'limited', 6500, 6, 'Limited collectible. Sample value data is included for demonstration.'],
      ['Legendary Sword', 'legendary-sword', 'https://images.unsplash.com/photo-1518709594023-6eab9bab7b23?auto=format&fit=crop&w=900&q=80', 'limited', 12000, 7, 'A limited collectible with a loyal collector audience.']
    ];
    const insert = db.prepare('INSERT INTO items (name, slug, image_url, category_id, value, demand, description) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const transaction = db.transaction(() => {
      for (const [name, slug, image, category, value, demand, description] of items) {
        insert.run(name, slug, image, categories[category], value, demand, description);
      }
    });
    transaction();
  }

  const upsertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING');
  for (const [key, value] of Object.entries(defaultSettings)) upsertSetting.run(key, value);
}

seedDatabase();

export function getSettings() {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((row) => [row.key, row.value]));
}

export function getItemBySlug(slug) {
  return db.prepare(`
    SELECT items.*, categories.name AS category, categories.slug AS category_slug
    FROM items JOIN categories ON categories.id = items.category_id
    WHERE items.slug = ?
  `).get(slug);
}

export function publicItem(item) {
  if (!item) return item;
  return {
    ...item,
    value: Number(item.value),
    demand: Number(item.demand)
  };
}