import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type BotType =
  | 'upi_normal'
  | 'upi_advanced'
  | 'redeem_normal'
  | 'redeem_advanced'
  | 'star_normal'
  | 'star_advanced'
  | 'gmail_bot';

export interface BotRow {
  id: number;
  owner_id: number;
  token: string;
  bot_id_tg: number;
  bot_username: string;
  bot_name: string;
  bot_type: BotType;
  is_active: number;
  per_refer: number;
  min_withdraw: number;
  daily_bonus: number;
  currency: string;
  withdrawals_open: number;
  maintenance: number;
  device_verify: number;
  support_username: string;
  deposit_enabled: number;
  deposit_qr_file_id: string;
  deposit_upi_id: string;
  min_deposit: number;
  gmail_sell_price: number;
  gmail_sell_open: number;
  created_at: number;
}

export interface MasterUserRow {
  user_id: number;
  username: string;
  first_name: string;
  coins: number;
  referred_by: number;
  ref_credited: number;
  total_refs: number;
  last_daily_at: number;
  is_banned: number;
  device_verified: number;
  device_hash: string;
  device_ip: string;
  state: string;
  state_data: string;
  joined_at: number;
  last_active_at: number;
}

export interface ChildUserRow {
  id: number;
  bot_db_id: number;
  user_id: number;
  username: string;
  first_name: string;
  balance: number;
  total_earned: number;
  total_withdrawn: number;
  upi_id: string;
  referred_by: number;
  ref_credited: number;
  total_refs: number;
  last_daily_at: number;
  is_banned: number;
  device_verified: number;
  device_hash: string;
  device_ip: string;
  state: string;
  state_data: string;
  joined_at: number;
  last_active_at: number;
}

export interface ChannelRow {
  id: number;
  chat_id: string;
  title: string;
  invite_link: string;
  created_at: number;
}

export interface WithdrawalRow {
  id: number;
  bot_db_id: number;
  user_id: number;
  amount: number;
  upi_id: string;
  status: string;
  note: string;
  created_at: number;
  processed_at: number;
  first_name?: string;
  username?: string;
}

export interface DepositRow {
  id: number;
  user_id: number;
  amount_rs: number;
  coins: number;
  utr: string;
  screenshot_file_id: string;
  status: string;
  processed_by: number;
  created_at: number;
  processed_at: number;
  first_name?: string;
  username?: string;
}

export interface RedeemPlanRow {
  id: number;
  bot_db_id: number;
  title: string;
  cost: number;
  is_active: number;
  created_at: number;
  stock_count?: number;
}

export interface ChildTaskRow {
  id: number;
  bot_db_id: number;
  title: string;
  url: string;
  reward: number;
  is_active: number;
  created_at: number;
}

export interface ChildPromoRow {
  id: number;
  bot_db_id: number;
  code: string;
  reward: number;
  max_uses: number;
  used_count: number;
  created_at: number;
}

export interface ChildDepositRow {
  id: number;
  bot_db_id: number;
  user_id: number;
  amount: number;
  utr: string;
  screenshot_file_id: string;
  status: string;
  processed_by: number;
  created_at: number;
  processed_at: number;
  first_name?: string;
  username?: string;
}

export interface GmailPlanRow {
  id: number;
  bot_db_id: number;
  title: string;
  price: number;
  is_active: number;
  created_at: number;
  stock_count?: number;
}

export interface GmailSellRow {
  id: number;
  bot_db_id: number;
  user_id: number;
  account_data: string;
  price: number;
  status: string;
  processed_by: number;
  created_at: number;
  processed_at: number;
  first_name?: string;
  username?: string;
}

export function esc(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtNum(num: number): string {
  if (Math.abs(num - Math.round(num)) < 0.00001) {
    return String(Math.round(num));
  }
  return num.toFixed(2).replace(/\.?0+$/, '');
}

export function fmtDuration(seconds: number): string {
  if (seconds <= 0) return 'now';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function fmtDateShort(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

export function isStarBotType(t: string): boolean {
  return t === 'star_normal' || t === 'star_advanced';
}

export function isRedeemBotType(t: string): boolean {
  return t === 'redeem_normal' || t === 'redeem_advanced';
}

export function isAdvancedBotType(t: string): boolean {
  return t === 'upi_advanced' || t === 'redeem_advanced' || t === 'star_advanced';
}

export function isGmailBotType(t: string): boolean {
  return t === 'gmail_bot';
}

export function fmtAmount(currency: string, amount: number): string {
  if (currency === '⭐') return `${fmtNum(amount)} ⭐`;
  return `${currency}${fmtNum(amount)}`;
}

export function botTypeLabel(t: string): string {
  if (t === 'upi_advanced') return '🚀 Advanced UPI Bot';
  if (t === 'redeem_normal') return '🎟 Normal Redeem Bot';
  if (t === 'redeem_advanced') return '💎 Advanced Redeem Bot';
  if (t === 'star_normal') return '⭐ Normal Star Bot';
  if (t === 'star_advanced') return '🌟 Advanced Star Bot';
  if (t === 'gmail_bot') return '📧 Gmail Buy & Sell Bot';
  return '💸 Normal UPI Bot';
}

export function withTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw err;
  }
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function openBotDb(
  dbPath?: string,
  defaults?: { dailyCoins: number; botCost: number; masterRefCoins: number }
): DatabaseSync {
  const file = dbPath || path.resolve(process.cwd(), 'bot_factory_data.sqlite');
  const db = new DatabaseSync(file);

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS master_admins (
      user_id INTEGER PRIMARY KEY,
      added_by INTEGER NOT NULL DEFAULT 0,
      added_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS master_users (
      user_id INTEGER PRIMARY KEY,
      username TEXT DEFAULT '',
      first_name TEXT DEFAULT '',
      coins REAL NOT NULL DEFAULT 0,
      referred_by INTEGER NOT NULL DEFAULT 0,
      ref_credited INTEGER NOT NULL DEFAULT 0,
      total_refs INTEGER NOT NULL DEFAULT 0,
      last_daily_at INTEGER NOT NULL DEFAULT 0,
      is_banned INTEGER NOT NULL DEFAULT 0,
      device_verified INTEGER NOT NULL DEFAULT 0,
      device_hash TEXT DEFAULT '',
      device_ip TEXT DEFAULT '',
      state TEXT DEFAULT '',
      state_data TEXT DEFAULT '',
      joined_at INTEGER NOT NULL DEFAULT 0,
      last_active_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS master_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL DEFAULT '',
      invite_link TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount_rs REAL NOT NULL,
      coins REAL NOT NULL,
      utr TEXT NOT NULL,
      screenshot_file_id TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      processed_by INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      processed_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      bot_id_tg INTEGER NOT NULL DEFAULT 0,
      bot_username TEXT NOT NULL DEFAULT '',
      bot_name TEXT NOT NULL DEFAULT '',
      bot_type TEXT NOT NULL DEFAULT 'upi_normal',
      is_active INTEGER NOT NULL DEFAULT 1,
      per_refer REAL NOT NULL DEFAULT 10.0,
      min_withdraw REAL NOT NULL DEFAULT 50.0,
      daily_bonus REAL NOT NULL DEFAULT 5.0,
      currency TEXT NOT NULL DEFAULT '₹',
      withdrawals_open INTEGER NOT NULL DEFAULT 1,
      maintenance INTEGER NOT NULL DEFAULT 0,
      device_verify INTEGER NOT NULL DEFAULT 1,
      support_username TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS child_admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_db_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      added_by INTEGER NOT NULL DEFAULT 0,
      added_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(bot_db_id, user_id),
      FOREIGN KEY(bot_db_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS child_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_db_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      username TEXT DEFAULT '',
      first_name TEXT DEFAULT '',
      balance REAL NOT NULL DEFAULT 0.0,
      total_earned REAL NOT NULL DEFAULT 0.0,
      total_withdrawn REAL NOT NULL DEFAULT 0.0,
      upi_id TEXT DEFAULT '',
      referred_by INTEGER NOT NULL DEFAULT 0,
      ref_credited INTEGER NOT NULL DEFAULT 0,
      total_refs INTEGER NOT NULL DEFAULT 0,
      last_daily_at INTEGER NOT NULL DEFAULT 0,
      is_banned INTEGER NOT NULL DEFAULT 0,
      device_verified INTEGER NOT NULL DEFAULT 0,
      device_hash TEXT DEFAULT '',
      device_ip TEXT DEFAULT '',
      state TEXT DEFAULT '',
      state_data TEXT DEFAULT '',
      joined_at INTEGER NOT NULL DEFAULT 0,
      last_active_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(bot_db_id, user_id),
      FOREIGN KEY(bot_db_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS child_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_db_id INTEGER NOT NULL,
      chat_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      invite_link TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(bot_db_id, chat_id),
      FOREIGN KEY(bot_db_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_db_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      upi_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0,
      processed_at INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(bot_db_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS redeem_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_db_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      cost REAL NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(bot_db_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS redeem_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_db_id INTEGER NOT NULL,
      plan_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      is_used INTEGER NOT NULL DEFAULT 0,
      used_by INTEGER NOT NULL DEFAULT 0,
      used_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(bot_db_id) REFERENCES bots(id) ON DELETE CASCADE,
      FOREIGN KEY(plan_id) REFERENCES redeem_plans(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS child_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_db_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      reward REAL NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(bot_db_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS child_task_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_db_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      claimed_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(bot_db_id, task_id, user_id),
      FOREIGN KEY(bot_db_id) REFERENCES bots(id) ON DELETE CASCADE,
      FOREIGN KEY(task_id) REFERENCES child_tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS child_promos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_db_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      reward REAL NOT NULL,
      max_uses INTEGER NOT NULL DEFAULT 100,
      used_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(bot_db_id, code),
      FOREIGN KEY(bot_db_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS child_promo_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_db_id INTEGER NOT NULL,
      promo_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      claimed_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(bot_db_id, promo_id, user_id),
      FOREIGN KEY(bot_db_id) REFERENCES bots(id) ON DELETE CASCADE,
      FOREIGN KEY(promo_id) REFERENCES child_promos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS device_tokens (
      token TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      bot_db_id INTEGER NOT NULL DEFAULT 0,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0,
      used INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS child_deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_db_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      utr TEXT NOT NULL,
      screenshot_file_id TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      processed_by INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      processed_at INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(bot_db_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gmail_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_db_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      price REAL NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(bot_db_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gmail_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_db_id INTEGER NOT NULL,
      plan_id INTEGER NOT NULL,
      account_data TEXT NOT NULL,
      is_sold INTEGER NOT NULL DEFAULT 0,
      sold_to INTEGER NOT NULL DEFAULT 0,
      sold_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(bot_db_id) REFERENCES bots(id) ON DELETE CASCADE,
      FOREIGN KEY(plan_id) REFERENCES gmail_plans(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gmail_sell_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_db_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      account_data TEXT NOT NULL,
      price REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      processed_by INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      processed_at INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(bot_db_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_child_users_bot ON child_users(bot_db_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_withdrawals_bot_status ON withdrawals(bot_db_id, status);
    CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_id);
    CREATE INDEX IF NOT EXISTS idx_redeem_codes_plan ON redeem_codes(plan_id, is_used);
    CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);
    CREATE INDEX IF NOT EXISTS idx_child_deposits_bot ON child_deposits(bot_db_id, status);
    CREATE INDEX IF NOT EXISTS idx_gmail_stock_plan ON gmail_stock(plan_id, is_sold);
    CREATE INDEX IF NOT EXISTS idx_gmail_sell_bot ON gmail_sell_requests(bot_db_id, status);
  `);

  // Safe migrations for existing databases
  ensureColumn(db, 'master_users', 'device_verified', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'master_users', 'device_hash', "TEXT DEFAULT ''");
  ensureColumn(db, 'master_users', 'device_ip', "TEXT DEFAULT ''");

  ensureColumn(db, 'child_users', 'device_verified', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'child_users', 'device_hash', "TEXT DEFAULT ''");
  ensureColumn(db, 'child_users', 'device_ip', "TEXT DEFAULT ''");

  ensureColumn(db, 'bots', 'bot_type', "TEXT NOT NULL DEFAULT 'upi_normal'");
  ensureColumn(db, 'bots', 'device_verify', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'bots', 'deposit_enabled', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'bots', 'deposit_qr_file_id', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'bots', 'deposit_upi_id', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'bots', 'min_deposit', 'REAL NOT NULL DEFAULT 10.0');
  ensureColumn(db, 'bots', 'gmail_sell_price', 'REAL NOT NULL DEFAULT 5.0');
  ensureColumn(db, 'bots', 'gmail_sell_open', 'INTEGER NOT NULL DEFAULT 1');
  db.exec("UPDATE bots SET currency = '₹' WHERE currency != '₹' AND bot_type NOT IN ('star_normal', 'star_advanced')");
  db.exec("UPDATE bots SET currency = '⭐' WHERE currency != '⭐' AND bot_type IN ('star_normal', 'star_advanced')");

  const dDaily = defaults?.dailyCoins ?? 2;
  const dCost = defaults?.botCost ?? 5;
  const dRef = defaults?.masterRefCoins ?? 1;

  const seed = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  seed.run('daily_coins', String(dDaily));
  seed.run('bot_cost', String(dCost));
  seed.run('cost_upi_normal', String(dCost));
  seed.run('cost_upi_advanced', String(dCost * 2));
  seed.run('cost_redeem_normal', String(dCost));
  seed.run('cost_redeem_advanced', String(dCost * 2));
  seed.run('cost_star_normal', String(dCost));
  seed.run('cost_star_advanced', String(dCost * 2));
  seed.run('cost_gmail_bot', String(dCost * 2));
  seed.run('master_ref_coins', String(dRef));
  seed.run('maintenance', '0');
  seed.run('support_username', '@Support');
  seed.run('master_bot_username', '');
  seed.run('master_device_verify', '1');
  seed.run('deposit_enabled', '1');
  seed.run('deposit_rs', '10');
  seed.run('deposit_coins', '5');
  seed.run('min_deposit_rs', '10');
  seed.run('deposit_qr_file_id', '');
  seed.run('deposit_upi_id', '');

  return db;
}
