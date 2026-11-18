import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  botTypeLabel,
  esc,
  fmtAmount,
  fmtDateShort,
  fmtDuration,
  fmtNum,
  isAdvancedBotType,
  isGmailBotType,
  isRedeemBotType,
  isStarBotType,
  openBotDb,
  withTx,
  type BotRow,
  type BotType,
  type ChannelRow,
  type ChildDepositRow,
  type ChildPromoRow,
  type ChildTaskRow,
  type ChildUserRow,
  type DepositRow,
  type GmailPlanRow,
  type GmailSellRow,
  type MasterUserRow,
  type RedeemPlanRow,
  type WithdrawalRow,
} from './db.ts';
import {
  answerCb,
  buildForceJoinMarkup,
  checkForceJoin,
  editMsg,
  executeBroadcast,
  resolveChannelInput,
  sendMsg,
  sendPhotoMsg,
  sleep,
  tgApi,
  type TgButtonStyle,
} from './tgApi.ts';

export interface BotManagerConfig {
  masterToken: string;
  masterAdminIds: number[];
  verifyBaseUrl?: string;
  dbPath?: string;
  defaultDailyCoins?: number;
  defaultBotCost?: number;
  defaultMasterRefCoins?: number;
}

export interface LiveBotStatus {
  masterRunning: boolean;
  masterUsername: string;
  masterBotName: string;
  masterAdminIds: number[];
  addedMasterAdmins: number[];
  verifyBaseUrl: string;
  activeChildRunners: number;
  stats: {
    masterUsers: number;
    activeUsers24h: number;
    bannedUsers: number;
    verifiedDevices: number;
    totalCoinsHeld: number;
    pendingDeposits: number;
    totalBots: number;
    activeBots: number;
    totalChildUsers: number;
    pendingWithdrawals: number;
  };
  settings: {
    dailyCoins: number;
    costUpiNormal: number;
    costUpiAdvanced: number;
    costRedeemNormal: number;
    costRedeemAdvanced: number;
    costStarNormal: number;
    costStarAdvanced: number;
    costGmailBot: number;
    masterRefCoins: number;
    maintenance: boolean;
    deviceVerify: boolean;
    depositEnabled: boolean;
    depositRs: number;
    depositCoins: number;
    minDepositRs: number;
    hasDepositQr: boolean;
    depositUpiId: string;
    supportUsername: string;
  };
  bots: Array<{
    id: number;
    botUsername: string;
    botName: string;
    botType: string;
    ownerId: number;
    isActive: boolean;
    usersCount: number;
    perRefer: number;
    minWithdraw: number;
    currency: string;
    pendingWithdrawals: number;
  }>;
  lastError: string | null;
}

export class BotManager {
  private db: DatabaseSync;
  private masterToken: string;
  private primaryAdminIds: number[];
  private defaultVerifyBaseUrl: string;
  private masterUsername = '';
  private masterBotName = '';
  private masterRunning = false;
  private masterAbort: AbortController | null = null;
  private childControllers = new Map<number, AbortController>();
  private lastError: string | null = null;

  constructor(cfg: BotManagerConfig) {
    this.masterToken = cfg.masterToken.trim();
    this.primaryAdminIds = cfg.masterAdminIds;
    this.defaultVerifyBaseUrl = (cfg.verifyBaseUrl || '').trim().replace(/\/+$/, '');
    this.db = openBotDb(cfg.dbPath, {
      dailyCoins: cfg.defaultDailyCoins ?? 2,
      botCost: cfg.defaultBotCost ?? 5,
      masterRefCoins: cfg.defaultMasterRefCoins ?? 1,
    });
  }

  private getSetting(key: string, fallback = ''): string {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? String(row.value) : fallback;
  }

  private setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  private getAllMasterAdmins(): number[] {
    const extra = (this.db.prepare('SELECT user_id FROM master_admins').all() as unknown as Array<{ user_id: number }>).map(
      (r) => Number(r.user_id)
    );
    return Array.from(new Set([...this.primaryAdminIds, ...extra]));
  }

  private isMasterAdmin(userId: number): boolean {
    if (this.primaryAdminIds.includes(userId)) return true;
    const row = this.db.prepare('SELECT 1 FROM master_admins WHERE user_id = ?').get(userId);
    return Boolean(row);
  }

  private isChildAdmin(bot: BotRow, userId: number): boolean {
    if (userId === bot.owner_id) return true;
    const row = this.db.prepare('SELECT 1 FROM child_admins WHERE bot_db_id = ? AND user_id = ?').get(bot.id, userId);
    return Boolean(row);
  }

  private getVerifyBaseUrl(): string {
    const custom = this.getSetting('verify_base_url', '').trim().replace(/\/+$/, '');
    if (custom) return custom;
    return this.defaultVerifyBaseUrl;
  }

  // ============================================================================
  // START / STOP LONG-POLLING RUNNERS
  // ============================================================================
  public async start(): Promise<void> {
    if (!this.masterToken || this.masterToken.includes('YOUR_MASTER_BOT_TOKEN')) {
      this.lastError = 'MASTER_BOT_TOKEN is not configured.';
      return;
    }
    if (this.masterRunning) return;

    const me = await tgApi<{ id: number; username: string; first_name: string }>(this.masterToken, 'getMe');
    if (!me.ok || !me.result) {
      this.lastError = me.description || 'Failed to verify Master Bot token.';
      console.error('[BotManager] Master getMe failed:', this.lastError);
      return;
    }

    this.masterUsername = me.result.username || '';
    this.masterBotName = me.result.first_name || 'Bot Maker';
    this.setSetting('master_bot_username', this.masterUsername);
    this.lastError = null;

    await tgApi(this.masterToken, 'deleteWebhook', { drop_pending_updates: false });

    this.masterRunning = true;
    this.masterAbort = new AbortController();
    void this.runMasterLoop(this.masterAbort.signal);

    const activeBots = this.db.prepare('SELECT * FROM bots WHERE is_active = 1').all() as unknown as BotRow[];
    for (const bot of activeBots) {
      void this.startChildRunner(bot.id);
    }

    console.log(
      `[BotManager] Master Bot @${this.masterUsername} LIVE (Admins: ${this.getAllMasterAdmins().join(', ')}) + ${activeBots.length} child bot(s).`
    );
  }

  public stop(): void {
    this.masterRunning = false;
    this.masterAbort?.abort();
    this.masterAbort = null;
    for (const [, ctrl] of this.childControllers) {
      ctrl.abort();
    }
    this.childControllers.clear();
  }

  public async restart(): Promise<void> {
    this.stop();
    await sleep(300);
    await this.start();
  }

  private async runMasterLoop(signal: AbortSignal): Promise<void> {
    let offset = 0;
    while (!signal.aborted && this.masterRunning) {
      try {
        const res = await tgApi<Array<{ update_id: number; [k: string]: unknown }>>(
          this.masterToken,
          'getUpdates',
          { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] },
          signal,
          35000
        );
        if (!res.ok) {
          if (!signal.aborted) {
            this.lastError = res.description || 'Polling error';
            await sleep(2500);
          }
          continue;
        }
        this.lastError = null;
        for (const upd of res.result || []) {
          offset = Math.max(offset, Number(upd.update_id) + 1);
          try {
            await this.handleMasterUpdate(upd);
          } catch (err) {
            console.error('[MasterUpdate Error]', err);
          }
        }
      } catch {
        if (!signal.aborted) await sleep(2500);
      }
    }
  }

  public async startChildRunner(botId: number): Promise<void> {
    this.stopChildRunner(botId);
    const bot = this.db.prepare('SELECT * FROM bots WHERE id = ? AND is_active = 1').get(botId) as unknown as BotRow | undefined;
    if (!bot) return;

    await tgApi(bot.token, 'deleteWebhook', { drop_pending_updates: false });
    const ctrl = new AbortController();
    this.childControllers.set(botId, ctrl);
    void this.runChildLoop(botId, bot.token, ctrl.signal);
  }

  public stopChildRunner(botId: number): void {
    const existing = this.childControllers.get(botId);
    if (existing) {
      existing.abort();
      this.childControllers.delete(botId);
    }
  }

  private async runChildLoop(botId: number, token: string, signal: AbortSignal): Promise<void> {
    let offset = 0;
    while (!signal.aborted) {
      try {
        const res = await tgApi<Array<{ update_id: number; [k: string]: unknown }>>(
          token,
          'getUpdates',
          { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] },
          signal,
          35000
        );
        if (!res.ok) {
          if (res.error_code === 401) {
            this.db.prepare('UPDATE bots SET is_active = 0 WHERE id = ?').run(botId);
            this.stopChildRunner(botId);
            return;
          }
          if (!signal.aborted) await sleep(3000);
          continue;
        }
        for (const upd of res.result || []) {
          offset = Math.max(offset, Number(upd.update_id) + 1);
          const freshBot = this.db.prepare('SELECT * FROM bots WHERE id = ?').get(botId) as unknown as BotRow | undefined;
          if (!freshBot) {
            this.stopChildRunner(botId);
            return;
          }
          try {
            await this.handleChildUpdate(freshBot, upd);
          } catch (err) {
            console.error(`[ChildUpdate #${botId} Error]`, err);
          }
        }
      } catch {
        if (!signal.aborted) await sleep(3000);
      }
    }
  }

  // ============================================================================
  // DEVICE VERIFICATION WEB API HANDLERS
  // ============================================================================
  public getDeviceTokenInfo(token: string): { valid: boolean; botLabel: string } {
    const row = this.db
      .prepare('SELECT * FROM device_tokens WHERE token = ? AND used = 0')
      .get(token) as { scope: string; bot_db_id: number; created_at: number } | undefined;
    const now = Math.floor(Date.now() / 1000);
    if (!row || now - row.created_at > 1800) {
      return { valid: false, botLabel: 'Telegram Bot' };
    }
    if (row.scope === 'master') {
      return { valid: true, botLabel: this.masterBotName || `@${this.masterUsername}` };
    }
    const bot = this.db.prepare('SELECT bot_name, bot_username FROM bots WHERE id = ?').get(row.bot_db_id) as
      | { bot_name: string; bot_username: string }
      | undefined;
    return { valid: true, botLabel: bot?.bot_name || `@${bot?.bot_username || 'Bot'}` };
  }

  public async verifyDeviceByToken(
    token: string,
    deviceHash: string,
    ip: string
  ): Promise<{ ok: boolean; status: number; message?: string; error?: string }> {
    const cleanHash = deviceHash.trim().slice(0, 128);
    if (!token || !cleanHash) {
      return { ok: false, status: 400, error: 'Missing verification token or device fingerprint.' };
    }

    const row = this.db.prepare('SELECT * FROM device_tokens WHERE token = ?').get(token) as
      | { token: string; scope: string; bot_db_id: number; user_id: number; created_at: number; used: number }
      | undefined;

    const now = Math.floor(Date.now() / 1000);
    if (!row || row.used === 1 || now - row.created_at > 1800) {
      return { ok: false, status: 400, error: 'Verification link expired. Request a new one in Telegram.' };
    }

    if (row.scope === 'master') {
      const dup = this.db
        .prepare('SELECT user_id FROM master_users WHERE device_hash = ? AND device_verified = 1 AND user_id != ?')
        .get(cleanHash, row.user_id) as { user_id: number } | undefined;
      if (dup) {
        await sendMsg(
          this.masterToken,
          row.user_id,
          '🚫 <b>Device Verification Failed</b>\n\nThis device is already registered to another Telegram account. Multi-accounting is not allowed.'
        );
        return {
          ok: false,
          status: 409,
          error: 'This device is already linked to another Telegram account.',
        };
      }

      this.db
        .prepare('UPDATE master_users SET device_verified = 1, device_hash = ?, device_ip = ? WHERE user_id = ?')
        .run(cleanHash, ip.slice(0, 64), row.user_id);
      this.db.prepare('UPDATE device_tokens SET used = 1 WHERE token = ?').run(token);

      await this.creditMasterReferralIfEligible(row.user_id);
      await this.sendMasterHome(row.user_id, row.user_id, 'Device Verified! You now have full access.');
      return { ok: true, status: 200, message: 'Device verified! You can return to Telegram now.' };
    }

    // Child Bot scope
    const bot = this.db.prepare('SELECT * FROM bots WHERE id = ?').get(row.bot_db_id) as unknown as BotRow | undefined;
    if (!bot) {
      return { ok: false, status: 404, error: 'Bot not found.' };
    }

    const dup = this.db
      .prepare(
        'SELECT user_id FROM child_users WHERE bot_db_id = ? AND device_hash = ? AND device_verified = 1 AND user_id != ?'
      )
      .get(bot.id, cleanHash, row.user_id) as { user_id: number } | undefined;
    if (dup) {
      await sendMsg(
        bot.token,
        row.user_id,
        '🚫 <b>Device Verification Failed</b>\n\nThis device is already registered to another account in this bot.'
      );
      return {
        ok: false,
        status: 409,
        error: 'This device is already linked to another Telegram account.',
      };
    }

    this.db
      .prepare('UPDATE child_users SET device_verified = 1, device_hash = ?, device_ip = ? WHERE bot_db_id = ? AND user_id = ?')
      .run(cleanHash, ip.slice(0, 64), bot.id, row.user_id);
    this.db.prepare('UPDATE device_tokens SET used = 1 WHERE token = ?').run(token);

    const user = this.db
      .prepare('SELECT * FROM child_users WHERE bot_db_id = ? AND user_id = ?')
      .get(bot.id, row.user_id) as unknown as ChildUserRow | undefined;
    if (user) {
      if (user.referred_by > 0 && user.ref_credited === 0) {
        await this.creditChildReferralIfEligible(bot, row.user_id);
      }
      await this.sendChildHome(bot, user, row.user_id, 'Device Verified! Welcome.');
    }
    return { ok: true, status: 200, message: 'Device verified! Return to Telegram now.' };
  }

  private createDeviceVerifyLink(scope: 'master' | 'child', botDbId: number, userId: number): string | null {
    const base = this.getVerifyBaseUrl();
    if (!base.startsWith('https://') && !base.startsWith('http://')) return null;
    const token = crypto.randomBytes(16).toString('hex');
    this.db
      .prepare('INSERT INTO device_tokens (token, scope, bot_db_id, user_id, created_at, used) VALUES (?, ?, ?, ?, ?, 0)')
      .run(token, scope, botDbId, userId, Math.floor(Date.now() / 1000));
    return `${base}/verify?token=${token}`;
  }

  // ============================================================================
  // DASHBOARD LIVE STATUS & SETTINGS SYNC
  // ============================================================================
  public getStatus(): LiveBotStatus {
    const now = Math.floor(Date.now() / 1000);
    const masterUsers = Number((this.db.prepare('SELECT COUNT(*) AS c FROM master_users').get() as { c: number }).c);
    const activeUsers24h = Number(
      (this.db.prepare('SELECT COUNT(*) AS c FROM master_users WHERE last_active_at >= ?').get(now - 86400) as { c: number }).c
    );
    const bannedUsers = Number((this.db.prepare('SELECT COUNT(*) AS c FROM master_users WHERE is_banned = 1').get() as { c: number }).c);
    const verifiedDevices = Number(
      (this.db.prepare('SELECT COUNT(*) AS c FROM master_users WHERE device_verified = 1').get() as { c: number }).c
    );
    const totalCoinsHeld = Number(
      (this.db.prepare('SELECT COALESCE(SUM(coins), 0) AS s FROM master_users').get() as { s: number }).s
    );
    const pendingDeposits = Number(
      (this.db.prepare("SELECT COUNT(*) AS c FROM deposits WHERE status = 'pending'").get() as { c: number }).c
    );
    const totalBots = Number((this.db.prepare('SELECT COUNT(*) AS c FROM bots').get() as { c: number }).c);
    const activeBots = Number((this.db.prepare('SELECT COUNT(*) AS c FROM bots WHERE is_active = 1').get() as { c: number }).c);
    const totalChildUsers = Number((this.db.prepare('SELECT COUNT(*) AS c FROM child_users').get() as { c: number }).c);
    const pendingWithdrawals = Number(
      (this.db.prepare("SELECT COUNT(*) AS c FROM withdrawals WHERE status = 'pending'").get() as { c: number }).c
    );

    const addedAdmins = (
      this.db.prepare('SELECT user_id FROM master_admins ORDER BY added_at ASC').all() as unknown as Array<{ user_id: number }>
    ).map((r) => Number(r.user_id));

    const botRows = this.db
      .prepare(
        `SELECT b.*,
          (SELECT COUNT(*) FROM child_users cu WHERE cu.bot_db_id = b.id) AS users_cnt,
          (SELECT COUNT(*) FROM withdrawals w WHERE w.bot_db_id = b.id AND w.status = 'pending') AS pend_cnt
         FROM bots b ORDER BY b.id DESC LIMIT 50`
      )
      .all() as unknown as Array<BotRow & { users_cnt: number; pend_cnt: number }>;

    return {
      masterRunning: this.masterRunning,
      masterUsername: this.masterUsername || this.getSetting('master_bot_username', ''),
      masterBotName: this.masterBotName,
      masterAdminIds: this.getAllMasterAdmins(),
      addedMasterAdmins: addedAdmins,
      verifyBaseUrl: this.getVerifyBaseUrl(),
      activeChildRunners: this.childControllers.size,
      stats: {
        masterUsers,
        activeUsers24h,
        bannedUsers,
        verifiedDevices,
        totalCoinsHeld,
        pendingDeposits,
        totalBots,
        activeBots,
        totalChildUsers,
        pendingWithdrawals,
      },
      settings: {
        dailyCoins: Number(this.getSetting('daily_coins', '2')),
        costUpiNormal: Number(this.getSetting('cost_upi_normal', '5')),
        costUpiAdvanced: Number(this.getSetting('cost_upi_advanced', '10')),
        costRedeemNormal: Number(this.getSetting('cost_redeem_normal', '5')),
        costRedeemAdvanced: Number(this.getSetting('cost_redeem_advanced', '10')),
        costStarNormal: Number(this.getSetting('cost_star_normal', '5')),
        costStarAdvanced: Number(this.getSetting('cost_star_advanced', '10')),
        costGmailBot: Number(this.getSetting('cost_gmail_bot', '10')),
        masterRefCoins: Number(this.getSetting('master_ref_coins', '1')),
        maintenance: this.getSetting('maintenance', '0') === '1',
        deviceVerify: this.getSetting('master_device_verify', '1') === '1',
        depositEnabled: this.getSetting('deposit_enabled', '1') === '1',
        depositRs: Number(this.getSetting('deposit_rs', '10')),
        depositCoins: Number(this.getSetting('deposit_coins', '5')),
        minDepositRs: Number(this.getSetting('min_deposit_rs', '10')),
        hasDepositQr: this.getSetting('deposit_qr_file_id', '') !== '',
        depositUpiId: this.getSetting('deposit_upi_id', ''),
        supportUsername: this.getSetting('support_username', '@Support'),
      },
      bots: botRows.map((b) => ({
        id: b.id,
        botUsername: b.bot_username,
        botName: b.bot_name,
        botType: b.bot_type || 'upi_normal',
        ownerId: b.owner_id,
        isActive: b.is_active === 1,
        usersCount: Number(b.users_cnt),
        perRefer: Number(b.per_refer),
        minWithdraw: Number(b.min_withdraw),
        currency: b.currency,
        pendingWithdrawals: Number(b.pend_cnt),
      })),
      lastError: this.lastError,
    };
  }

  public updateMasterSettingsFromApi(input: {
    dailyCoins?: number;
    costUpiNormal?: number;
    costUpiAdvanced?: number;
    costRedeemNormal?: number;
    costRedeemAdvanced?: number;
    costStarNormal?: number;
    costStarAdvanced?: number;
    costGmailBot?: number;
    masterRefCoins?: number;
    maintenance?: boolean;
    deviceVerify?: boolean;
    depositEnabled?: boolean;
    depositRs?: number;
    depositCoins?: number;
    minDepositRs?: number;
    depositUpiId?: string;
    supportUsername?: string;
    verifyBaseUrl?: string;
  }): void {
    if (typeof input.dailyCoins === 'number' && input.dailyCoins >= 0) this.setSetting('daily_coins', String(input.dailyCoins));
    if (typeof input.costUpiNormal === 'number' && input.costUpiNormal >= 1) this.setSetting('cost_upi_normal', String(input.costUpiNormal));
    if (typeof input.costUpiAdvanced === 'number' && input.costUpiAdvanced >= 1) this.setSetting('cost_upi_advanced', String(input.costUpiAdvanced));
    if (typeof input.costRedeemNormal === 'number' && input.costRedeemNormal >= 1) this.setSetting('cost_redeem_normal', String(input.costRedeemNormal));
    if (typeof input.costRedeemAdvanced === 'number' && input.costRedeemAdvanced >= 1) this.setSetting('cost_redeem_advanced', String(input.costRedeemAdvanced));
    if (typeof input.costStarNormal === 'number' && input.costStarNormal >= 1) this.setSetting('cost_star_normal', String(input.costStarNormal));
    if (typeof input.costStarAdvanced === 'number' && input.costStarAdvanced >= 1) this.setSetting('cost_star_advanced', String(input.costStarAdvanced));
    if (typeof input.costGmailBot === 'number' && input.costGmailBot >= 1) this.setSetting('cost_gmail_bot', String(input.costGmailBot));
    if (typeof input.masterRefCoins === 'number' && input.masterRefCoins >= 0) this.setSetting('master_ref_coins', String(input.masterRefCoins));
    if (typeof input.maintenance === 'boolean') this.setSetting('maintenance', input.maintenance ? '1' : '0');
    if (typeof input.deviceVerify === 'boolean') this.setSetting('master_device_verify', input.deviceVerify ? '1' : '0');
    if (typeof input.depositEnabled === 'boolean') this.setSetting('deposit_enabled', input.depositEnabled ? '1' : '0');
    if (typeof input.depositRs === 'number' && input.depositRs > 0) this.setSetting('deposit_rs', String(input.depositRs));
    if (typeof input.depositCoins === 'number' && input.depositCoins > 0) this.setSetting('deposit_coins', String(input.depositCoins));
    if (typeof input.minDepositRs === 'number' && input.minDepositRs >= 1) this.setSetting('min_deposit_rs', String(input.minDepositRs));
    if (typeof input.depositUpiId === 'string') this.setSetting('deposit_upi_id', input.depositUpiId.trim());
    if (typeof input.supportUsername === 'string' && input.supportUsername.trim()) this.setSetting('support_username', input.supportUsername.trim());
    if (typeof input.verifyBaseUrl === 'string') this.setSetting('verify_base_url', input.verifyBaseUrl.trim().replace(/\/+$/, ''));
  }

  // ============================================================================
  // MASTER BOT ENGINE
  // ============================================================================
  private masterMainKeyboard(userId: number): Record<string, unknown> {
    const rows: Array<Array<{ text: string; style?: TgButtonStyle }>> = [
      [
        { text: '🎁 Daily Coins', style: 'success' },
        { text: '💰 My Balance', style: 'primary' },
      ],
      [
        { text: '🤖 Create Bot', style: 'primary' },
        { text: '📱 My Bots', style: 'primary' },
      ],
      [
        { text: '💳 Buy Coins', style: 'success' },
        { text: '👥 Refer & Earn', style: 'primary' },
      ],
      [{ text: '🆘 Support' }],
    ];
    if (this.isMasterAdmin(userId)) {
      rows.push([{ text: '🛡 Master Admin', style: 'danger' }]);
    }
    return { keyboard: rows, resize_keyboard: true, is_persistent: true };
  }

  private async creditMasterReferralIfEligible(userId: number): Promise<void> {
    const refCoins = Number(this.getSetting('master_ref_coins', '1'));
    const needDevVerify = this.getSetting('master_device_verify', '1') === '1';
    const result = withTx(this.db, () => {
      const u = this.db
        .prepare('SELECT referred_by, ref_credited, first_name, device_verified FROM master_users WHERE user_id = ?')
        .get(userId) as { referred_by: number; ref_credited: number; first_name: string; device_verified: number } | undefined;
      if (!u || u.referred_by <= 0 || u.ref_credited === 1) return null;
      if (needDevVerify && u.device_verified === 0) return null;
      const upd = this.db
        .prepare('UPDATE master_users SET ref_credited = 1 WHERE user_id = ? AND ref_credited = 0')
        .run(userId);
      if (upd.changes > 0) {
        this.db
          .prepare('UPDATE master_users SET coins = coins + ?, total_refs = total_refs + 1 WHERE user_id = ?')
          .run(refCoins, u.referred_by);
        return u;
      }
      return null;
    });

    if (result && refCoins > 0) {
      await sendMsg(
        this.masterToken,
        result.referred_by,
        `🎉 <b>New Verified Referral!</b>\n\n👤 User: <b>${esc(result.first_name)}</b> (<code>${userId}</code>)\n🪙 Earned: <b>+${fmtNum(refCoins)} Coins</b>`
      );
    }
  }

  private async handleMasterUpdate(update: Record<string, unknown>): Promise<void> {
    const msg = update.message as
      | {
          chat: { id: number };
          from: { id: number; username?: string; first_name?: string };
          text?: string;
          caption?: string;
          photo?: Array<{ file_id: string }>;
        }
      | undefined;
    const cb = update.callback_query as
      | {
          id: string;
          from: { id: number; username?: string; first_name?: string };
          message?: { chat: { id: number }; message_id: number };
          data?: string;
        }
      | undefined;

    if (!msg && !cb) return;
    const from = cb ? cb.from : msg!.from;
    const chatId = cb ? cb.message?.chat.id ?? 0 : msg!.chat.id;
    if (chatId <= 0) return;

    const userId = from.id;
    const username = from.username || '';
    const firstName = from.first_name || 'User';
    const text = (msg?.text || msg?.caption || '').trim();
    const photoFileId = msg?.photo && msg.photo.length > 0 ? msg.photo[msg.photo.length - 1].file_id : '';
    const data = (cb?.data || '').trim();
    const now = Math.floor(Date.now() / 1000);

    let refCandidate = 0;
    if (msg) {
      const m = text.match(/^\/start(?:\s+(\d+))?/);
      if (m?.[1]) {
        const cand = Number(m[1]);
        if (cand > 0 && cand !== userId) {
          const exists = this.db.prepare('SELECT user_id FROM master_users WHERE user_id = ?').get(cand);
          if (exists) refCandidate = cand;
        }
      }
    }

    let user = this.db.prepare('SELECT * FROM master_users WHERE user_id = ?').get(userId) as unknown as MasterUserRow | undefined;
    if (!user) {
      this.db
        .prepare(
          'INSERT INTO master_users (user_id, username, first_name, coins, referred_by, joined_at, last_active_at) VALUES (?, ?, ?, 0, ?, ?, ?)'
        )
        .run(userId, username, firstName, refCandidate, now, now);
      user = this.db.prepare('SELECT * FROM master_users WHERE user_id = ?').get(userId) as unknown as MasterUserRow;
    } else {
      this.db
        .prepare('UPDATE master_users SET username = ?, first_name = ?, last_active_at = ? WHERE user_id = ?')
        .run(username, firstName, now, userId);
      user.username = username;
      user.first_name = firstName;
    }

    if (user.is_banned === 1 && !this.isMasterAdmin(userId)) {
      if (cb) await answerCb(this.masterToken, cb.id, 'Your account is banned.', true);
      else await sendMsg(this.masterToken, chatId, '🚫 <b>Access Denied</b>\nYour account has been banned by the administrator.');
      return;
    }

    if (this.getSetting('maintenance', '0') === '1' && !this.isMasterAdmin(userId)) {
      if (cb) await answerCb(this.masterToken, cb.id, 'Bot is under maintenance.', true);
      else await sendMsg(this.masterToken, chatId, '🛠 <b>Bot Under Maintenance</b>\nPlease check back shortly.');
      return;
    }

    // 1. Force Join Check (Unlimited channels)
    if (!this.isMasterAdmin(userId)) {
      const channels = this.db.prepare('SELECT * FROM master_channels ORDER BY id ASC').all() as unknown as ChannelRow[];
      if (channels.length > 0) {
        const unjoined = await checkForceJoin(this.masterToken, channels, userId);
        if (unjoined.length > 0) {
          if (cb && data === 'm_verify_join') {
            await answerCb(this.masterToken, cb.id, 'Please join all required channels first!', true);
            return;
          }
          if (cb) await answerCb(this.masterToken, cb.id);
          await sendMsg(
            this.masterToken,
            chatId,
            `📢 <b>Join Required Channels (${unjoined.length} remaining)</b>\n\nJoin all channels below and tap <b>✅ I Joined / Verify</b>.`,
            buildForceJoinMarkup(unjoined, 'm_verify_join')
          );
          return;
        }
      }
    }

    if (cb && data === 'm_verify_join') {
      await answerCb(this.masterToken, cb.id, 'Channels verified!');
      if (cb.message) {
        await tgApi(this.masterToken, 'deleteMessage', { chat_id: chatId, message_id: cb.message.message_id });
      }
    }

    // 2. Device Verification Check (if enabled)
    if (this.getSetting('master_device_verify', '1') === '1' && !this.isMasterAdmin(userId) && user.device_verified === 0) {
      if (cb && data === 'm_check_dev') {
        await answerCb(this.masterToken, cb.id, 'Device not verified yet. Tap Verify My Device first!', true);
        return;
      }
      const verifyUrl = this.createDeviceVerifyLink('master', 0, userId);
      if (verifyUrl && verifyUrl.startsWith('https://')) {
        if (cb) await answerCb(this.masterToken, cb.id);
        await sendMsg(
          this.masterToken,
          chatId,
          '📱 <b>Device Verification Required</b>\n\n<blockquote>🛡 To prevent fake/multi-accounts, verify your device once using the button below:</blockquote>',
          {
            inline_keyboard: [
              [{ text: '📱 Verify My Device', url: verifyUrl, style: 'primary' }],
              [{ text: '🔄 I Verified', callback_data: 'm_check_dev', style: 'success' }],
            ],
          }
        );
        return;
      }
    }

    if (user.referred_by > 0 && user.ref_credited === 0) {
      await this.creditMasterReferralIfEligible(userId);
    }

    if (cb && data === 'm_verify_join') {
      await this.sendMasterHome(userId, chatId);
      return;
    }

    if (text === '❌ Cancel' || text === '/cancel') {
      this.db.prepare("UPDATE master_users SET state = '', state_data = '' WHERE user_id = ?").run(userId);
      await this.sendMasterHome(userId, chatId, 'Action cancelled.');
      return;
    }

    if (cb) {
      await this.handleMasterCallback(user, cb);
      return;
    }

    if ((text === '/admin' || text === '🛡 Master Admin') && this.isMasterAdmin(userId)) {
      this.db.prepare("UPDATE master_users SET state = '', state_data = '' WHERE user_id = ?").run(userId);
      await this.sendMasterAdminMenu(chatId);
      return;
    }

    const menuTriggers = [
      '/start',
      '/daily',
      '/balance',
      '/create',
      '/mybots',
      '/refer',
      '/buy',
      '/deposit',
      '🎁 Daily Coins',
      '💰 My Balance',
      '🤖 Create Bot',
      '📱 My Bots',
      '💳 Buy Coins',
      '👥 Refer & Earn',
      '🆘 Support',
    ];
    const isMenuCmd = menuTriggers.includes(text) || text.startsWith('/start ');

    if (isMenuCmd) {
      if (user.state !== '') {
        this.db.prepare("UPDATE master_users SET state = '', state_data = '' WHERE user_id = ?").run(userId);
        user.state = '';
        user.state_data = '';
      }
    } else if (user.state !== '') {
      await this.handleMasterState(user, chatId, text, photoFileId);
      return;
    }

    if (text === '/start' || text.startsWith('/start ')) {
      await this.sendMasterHome(userId, chatId);
    } else if (text === '🎁 Daily Coins' || text === '/daily') {
      await this.handleMasterDailyClaim(userId, chatId);
    } else if (text === '💰 My Balance' || text === '/balance') {
      await this.handleMasterBalance(userId, chatId);
    } else if (text === '👥 Refer & Earn' || text === '/refer') {
      await this.handleMasterRefer(userId, chatId);
    } else if (text === '🤖 Create Bot' || text === '/create') {
      await this.handleMasterCreateMenu(userId, chatId);
    } else if (text === '📱 My Bots' || text === '/mybots') {
      await this.handleMasterMyBots(userId, chatId);
    } else if (text === '💳 Buy Coins' || text === '/buy' || text === '/deposit') {
      await this.handleMasterBuyCoins(chatId);
    } else if (text === '🆘 Support') {
      const sup = this.getSetting('support_username', '@Support');
      await sendMsg(
        this.masterToken,
        chatId,
        `🆘 <b>Support</b>\n\nNeed help with your bot or coins?\nContact: ${esc(sup)}`,
        this.masterMainKeyboard(userId)
      );
    } else {
      await this.sendMasterHome(userId, chatId);
    }
  }

  private async sendMasterHome(userId: number, chatId: number, prefix = ''): Promise<void> {
    const row = this.db.prepare('SELECT coins FROM master_users WHERE user_id = ?').get(userId) as { coins: number };
    const dailyCoins = Number(this.getSetting('daily_coins', '2'));
    const costNormal = Number(this.getSetting('cost_upi_normal', '5'));
    const costAdv = Number(this.getSetting('cost_upi_advanced', '10'));

    const msg =
      (prefix ? `✨ <i>${esc(prefix)}</i>\n\n` : '') +
      `🌈 <b>Bot Maker Pro — UPI, Redeem, Star &amp; Gmail Bots</b>\n\n` +
      `Create <b>UPI Refer Bots</b>, <b>Redeem Code Bots</b>, <b>Telegram Star Bots</b> &amp; <b>Gmail Buy/Sell Bots</b> with full Admin Panels!\n\n` +
      `<blockquote>` +
      `🪙 <b>Your Coins:</b> <code>${fmtNum(row.coins)}</code>\n` +
      `🏷 <b>Bot Prices:</b> Normal <code>${costNormal}🪙</code> · Adv/Gmail <code>${costAdv}🪙</code>\n` +
      `🎁 <b>Daily Bonus:</b> <code>+${dailyCoins} Coins/day</code>` +
      `</blockquote>\n\n` +
      `🔥 Claim daily coins, refer friends, or tap <b>💳 Buy Coins</b> to launch your bot!`;

    await sendMsg(this.masterToken, chatId, msg, this.masterMainKeyboard(userId));
  }

  private async handleMasterDailyClaim(userId: number, chatId: number): Promise<void> {
    const dailyCoins = Number(this.getSetting('daily_coins', '2'));
    if (dailyCoins <= 0) {
      await sendMsg(this.masterToken, chatId, '🎁 Daily coin bonus is currently disabled by admin.', this.masterMainKeyboard(userId));
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const res = withTx(this.db, () => {
      const row = this.db
        .prepare('SELECT coins, last_daily_at FROM master_users WHERE user_id = ?')
        .get(userId) as { coins: number; last_daily_at: number };
      const diff = now - row.last_daily_at;
      if (diff < 86400) return { ok: false as const, wait: fmtDuration(86400 - diff) };
      this.db
        .prepare('UPDATE master_users SET coins = coins + ?, last_daily_at = ? WHERE user_id = ?')
        .run(dailyCoins, now, userId);
      return { ok: true as const, newCoins: row.coins + dailyCoins };
    });

    if (!res.ok) {
      await sendMsg(
        this.masterToken,
        chatId,
        `⏳ <b>Daily Coins Already Claimed</b>\n\nCome back in <b>${res.wait}</b> to claim <b>+${dailyCoins} Coins</b>!`,
        this.masterMainKeyboard(userId)
      );
      return;
    }

    await sendMsg(
      this.masterToken,
      chatId,
      `🎉 <b>Daily Bonus Claimed!</b>\n\n➕ Added: <b>+${dailyCoins} Coins</b>\n🪙 New Balance: <b>${fmtNum(res.newCoins)} Coins</b>`,
      this.masterMainKeyboard(userId)
    );
  }

  private async handleMasterBalance(userId: number, chatId: number): Promise<void> {
    const u = this.db
      .prepare('SELECT coins, total_refs, device_verified FROM master_users WHERE user_id = ?')
      .get(userId) as { coins: number; total_refs: number; device_verified: number };
    const botsCount = Number(
      (this.db.prepare('SELECT COUNT(*) AS c FROM bots WHERE owner_id = ?').get(userId) as { c: number }).c
    );
    const msg =
      `💰 <b>Your Account Balance</b>\n\n` +
      `<blockquote>` +
      `🪙 <b>Coins:</b> <code>${fmtNum(u.coins)}</code>\n` +
      `🤖 <b>Bots Created:</b> <code>${botsCount}</code>\n` +
      `👥 <b>Total Referrals:</b> <code>${u.total_refs}</code>\n` +
      `📱 <b>Device Status:</b> ${u.device_verified === 1 ? '✅ Verified' : '⏳ Pending'}` +
      `</blockquote>`;
    await sendMsg(this.masterToken, chatId, msg, this.masterMainKeyboard(userId));
  }

  private async handleMasterRefer(userId: number, chatId: number): Promise<void> {
    const refCoins = Number(this.getSetting('master_ref_coins', '1'));
    const u = this.db.prepare('SELECT total_refs FROM master_users WHERE user_id = ?').get(userId) as { total_refs: number };
    const uname = this.masterUsername || this.getSetting('master_bot_username', '');
    const link = `https://t.me/${uname}?start=${userId}`;
    const msg =
      `👥 <b>Refer &amp; Earn Coins</b>\n\n` +
      `Invite friends and earn <b>+${refCoins} Coin(s)</b> per verified referral!\n\n` +
      `<blockquote>🔗 <b>Your Link:</b>\n<code>${link}</code>\n\n` +
      `📊 <b>Total Verified Referrals:</b> <code>${u.total_refs}</code></blockquote>`;
    await sendMsg(this.masterToken, chatId, msg, {
      inline_keyboard: [
        [
          {
            text: '📤 Share Link Now',
            url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Create your own UPI & Redeem Code Telegram Bot!')}`,
            style: 'success',
          },
        ],
      ],
    });
  }

  private async handleMasterBuyCoins(chatId: number): Promise<void> {
    if (this.getSetting('deposit_enabled', '1') !== '1') {
      await sendMsg(this.masterToken, chatId, '💳 Coin deposits are temporarily closed by admin.');
      return;
    }
    const rs = Number(this.getSetting('deposit_rs', '10'));
    const coins = Number(this.getSetting('deposit_coins', '5'));
    const minRs = Number(this.getSetting('min_deposit_rs', '10'));
    const qrFileId = this.getSetting('deposit_qr_file_id', '');
    const upiId = this.getSetting('deposit_upi_id', '');

    const caption =
      `💳 <b>Buy Coins (Instant Deposit)</b>\n\n` +
      `<blockquote>` +
      `💱 <b>Rate:</b> <code>₹${fmtNum(rs)} = ${fmtNum(coins)} Coins</code>\n` +
      `📉 <b>Minimum Deposit:</b> <code>₹${fmtNum(minRs)}</code>` +
      (upiId ? `\n🏦 <b>Pay UPI ID:</b> <code>${esc(upiId)}</code>` : '') +
      `</blockquote>\n\n` +
      `Pay using the QR / UPI above, then tap <b>📥 I Have Paid</b> and submit your Amount &amp; UTR / Screenshot.`;

    const kb = {
      inline_keyboard: [[{ text: '📥 I Have Paid (Submit Deposit)', callback_data: 'm_dep_start', style: 'success' as TgButtonStyle }]],
    };

    if (qrFileId) {
      await sendPhotoMsg(this.masterToken, chatId, qrFileId, caption, kb);
    } else {
      await sendMsg(this.masterToken, chatId, caption, kb);
    }
  }

  private getBotTypeCost(type: BotType): number {
    if (type === 'upi_advanced') return Number(this.getSetting('cost_upi_advanced', '10'));
    if (type === 'redeem_normal') return Number(this.getSetting('cost_redeem_normal', '5'));
    if (type === 'redeem_advanced') return Number(this.getSetting('cost_redeem_advanced', '10'));
    if (type === 'star_normal') return Number(this.getSetting('cost_star_normal', '5'));
    if (type === 'star_advanced') return Number(this.getSetting('cost_star_advanced', '10'));
    if (type === 'gmail_bot') return Number(this.getSetting('cost_gmail_bot', '10'));
    return Number(this.getSetting('cost_upi_normal', '5'));
  }

  private async handleMasterCreateMenu(userId: number, chatId: number): Promise<void> {
    const u = this.db.prepare('SELECT coins FROM master_users WHERE user_id = ?').get(userId) as { coins: number };
    const cUpiN = this.getBotTypeCost('upi_normal');
    const cUpiA = this.getBotTypeCost('upi_advanced');
    const cRedN = this.getBotTypeCost('redeem_normal');
    const cRedA = this.getBotTypeCost('redeem_advanced');
    const cStarN = this.getBotTypeCost('star_normal');
    const cStarA = this.getBotTypeCost('star_advanced');
    const cGmail = this.getBotTypeCost('gmail_bot');

    const txt =
      `🌈 <b>Choose Your Bot Template</b>\n\n` +
      `🪙 Your Balance: <code>${fmtNum(u.coins)} Coins</code>\n\n` +
      `<blockquote>` +
      `💸 <b>Normal UPI Bot (<code>${cUpiN}🪙</code>)</b>: Refer &amp; Earn + UPI Withdrawals.\n` +
      `🚀 <b>Advanced UPI Bot (<code>${cUpiA}🪙</code>)</b>: UPI + Tasks + Gift Codes + Leaderboard.\n` +
      `🎟 <b>Normal Redeem Bot (<code>${cRedN}🪙</code>)</b>: Earn &amp; claim stocked Redeem Codes.\n` +
      `💎 <b>Advanced Redeem Bot (<code>${cRedA}🪙</code>)</b>: Redeem + Live Stock + Tasks + Promos.\n` +
      `⭐ <b>Normal Star Bot (<code>${cStarN}🪙</code>)</b>: Refer &amp; Earn Telegram Stars (⭐) + Withdraw.\n` +
      `🌟 <b>Advanced Star Bot (<code>${cStarA}🪙</code>)</b>: Stars + Gift Packs + Tasks + Promos + Top.\n` +
      `📧 <b>Gmail Buy &amp; Sell Bot (<code>${cGmail}🪙</code>)</b>: Buy/Sell Gmails + Deposit QR + Stock + Refer + Withdraw.` +
      `</blockquote>`;

    await sendMsg(this.masterToken, chatId, txt, {
      inline_keyboard: [
        [{ text: `💸 Normal UPI Bot (${cUpiN}🪙)`, callback_data: 'cb_type:upi_normal', style: 'primary' }],
        [{ text: `🚀 Advanced UPI Bot (${cUpiA}🪙)`, callback_data: 'cb_type:upi_advanced', style: 'success' }],
        [{ text: `🎟 Normal Redeem Code Bot (${cRedN}🪙)`, callback_data: 'cb_type:redeem_normal', style: 'primary' }],
        [{ text: `💎 Advanced Redeem Code Bot (${cRedA}🪙)`, callback_data: 'cb_type:redeem_advanced', style: 'success' }],
        [{ text: `⭐ Normal Star Bot (${cStarN}🪙)`, callback_data: 'cb_type:star_normal', style: 'primary' }],
        [{ text: `🌟 Advanced Star Bot (${cStarA}🪙)`, callback_data: 'cb_type:star_advanced', style: 'success' }],
        [{ text: `📧 Gmail Buy & Sell Bot (${cGmail}🪙)`, callback_data: 'cb_type:gmail_bot', style: 'primary' }],
      ],
    });
  }

  private async handleMasterMyBots(userId: number, chatId: number): Promise<void> {
    const bots = this.db
      .prepare(
        `SELECT b.*, (SELECT COUNT(*) FROM child_users cu WHERE cu.bot_db_id = b.id) AS total_users
         FROM bots b WHERE b.owner_id = ? ORDER BY b.id DESC`
      )
      .all(userId) as unknown as Array<BotRow & { total_users: number }>;

    if (bots.length === 0) {
      await sendMsg(
        this.masterToken,
        chatId,
        "📱 <b>My Bots</b>\n\nYou haven't created any bots yet. Tap <b>🤖 Create Bot</b> to launch your first bot!",
        this.masterMainKeyboard(userId)
      );
      return;
    }

    const rows = bots.map((b) => [
      {
        text: `${b.is_active === 1 ? '🟢' : '⏸'} @${b.bot_username} · ${botTypeLabel(b.bot_type)} (${b.total_users})`,
        callback_data: `mb_view:${b.id}`,
        style: (b.is_active === 1 ? 'primary' : 'danger') as TgButtonStyle,
      },
    ]);
    await sendMsg(this.masterToken, chatId, `📱 <b>Your Created Bots (${bots.length})</b>\n\nSelect a bot to manage:`, {
      inline_keyboard: rows,
    });
  }

  private async handleMasterState(user: MasterUserRow, chatId: number, text: string, photoFileId: string): Promise<void> {
    const userId = user.user_id;
    const state = user.state;
    let stateData: Record<string, unknown> = {};
    try {
      if (user.state_data) stateData = JSON.parse(user.state_data) as Record<string, unknown>;
    } catch {
      stateData = {};
    }

    // User submitting deposit amount
    if (state === 'm_dep_amt') {
      const amt = Number(text);
      const minRs = Number(this.getSetting('min_deposit_rs', '10'));
      if (!Number.isFinite(amt) || amt < minRs) {
        await sendMsg(this.masterToken, chatId, `❌ Minimum deposit is <b>₹${fmtNum(minRs)}</b>. Enter valid amount (or /cancel):`);
        return;
      }
      const rs = Number(this.getSetting('deposit_rs', '10'));
      const rateCoins = Number(this.getSetting('deposit_coins', '5'));
      const calcCoins = Math.round(((amt / rs) * rateCoins) * 100) / 100;
      this.db
        .prepare("UPDATE master_users SET state = 'm_dep_utr', state_data = ? WHERE user_id = ?")
        .run(JSON.stringify({ amt, calcCoins }), userId);
      await sendMsg(
        this.masterToken,
        chatId,
        `💵 Amount: <b>₹${fmtNum(amt)}</b> → You will receive: <b>${fmtNum(calcCoins)} Coins</b>\n\n` +
          `Now send your <b>12-digit UTR / Transaction ID</b> (or send a <b>Payment Screenshot photo</b> with UTR in caption):`
      );
      return;
    }

    // User submitting UTR or Screenshot
    if (state === 'm_dep_utr') {
      const amt = Number(stateData.amt || 0);
      const calcCoins = Number(stateData.calcCoins || 0);
      const utr = text.trim() || (photoFileId ? 'Screenshot Attached' : '');
      if (!utr && !photoFileId) {
        await sendMsg(this.masterToken, chatId, '❌ Send your UTR / Transaction ID or a payment screenshot.');
        return;
      }
      const ins = this.db
        .prepare(
          "INSERT INTO deposits (user_id, amount_rs, coins, utr, screenshot_file_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
        )
        .run(userId, amt, calcCoins, utr.slice(0, 120), photoFileId, Math.floor(Date.now() / 1000));
      const depId = Number(ins.lastInsertRowid);
      this.db.prepare("UPDATE master_users SET state = '', state_data = '' WHERE user_id = ?").run(userId);

      await sendMsg(
        this.masterToken,
        chatId,
        `✅ <b>Deposit Request Submitted (#${depId})</b>\n\n` +
          `💵 Paid: <b>₹${fmtNum(amt)}</b>\n` +
          `🪙 Coins: <b>+${fmtNum(calcCoins)}</b>\n` +
          `🧾 UTR: <code>${esc(utr)}</code>\n` +
          `📌 Status: <b>⏳ Pending Admin Approval</b>`,
        this.masterMainKeyboard(userId)
      );

      // Notify all Master Admins
      const adminCaption =
        `💳 <b>New Deposit Request #${depId}</b>\n\n` +
        `👤 User: <b>${esc(user.first_name)}</b> (<code>${userId}</code>)\n` +
        `💵 Amount: <b>₹${fmtNum(amt)}</b>\n` +
        `🪙 Coins: <b>+${fmtNum(calcCoins)}</b>\n` +
        `🧾 UTR: <code>${esc(utr)}</code>`;
      const admKb = {
        inline_keyboard: [
          [
            { text: `✅ Approve (+${fmtNum(calcCoins)}🪙)`, callback_data: `ma_dep_ok:${depId}`, style: 'success' },
            { text: '❌ Reject', callback_data: `ma_dep_no:${depId}`, style: 'danger' },
          ],
        ],
      };
      for (const admId of this.getAllMasterAdmins()) {
        if (photoFileId) await sendPhotoMsg(this.masterToken, admId, photoFileId, adminCaption, admKb);
        else await sendMsg(this.masterToken, admId, adminCaption, admKb);
      }
      return;
    }

    // User creating child bot
    if (state === 'await_bot_token') {
      const botType = (String(stateData.bot_type || 'upi_normal') as BotType);
      const tokenInput = text.trim();
      if (!/^\d{6,15}:[A-Za-z0-9_-]{25,}$/.test(tokenInput)) {
        await sendMsg(this.masterToken, chatId, '❌ Invalid Bot Token format. Paste the exact token from @BotFather or tap <b>❌ Cancel</b>.');
        return;
      }
      if (tokenInput === this.masterToken) {
        await sendMsg(this.masterToken, chatId, '❌ You cannot use the Master Bot token.');
        return;
      }
      const dup = this.db.prepare('SELECT id FROM bots WHERE token = ?').get(tokenInput);
      if (dup) {
        await sendMsg(this.masterToken, chatId, '❌ This bot token is already registered.');
        return;
      }
      const me = await tgApi<{ id: number; username?: string; first_name?: string }>(tokenInput, 'getMe');
      if (!me.ok || !me.result) {
        await sendMsg(this.masterToken, chatId, `❌ Telegram rejected this token: <code>${esc(me.description || 'Invalid token')}</code>`);
        return;
      }

      const botCost = this.getBotTypeCost(botType);
      const now = Math.floor(Date.now() / 1000);
      const tgBotId = me.result.id;
      const tgUsername = me.result.username || '';
      const tgName = me.result.first_name || 'Earn Bot';
      const sup = user.username ? `@${user.username}` : '';
      const isStar = isStarBotType(botType);
      const initPerRef = isStar ? 2.0 : 10.0;
      const initMinWd = isStar ? 15.0 : 50.0;
      const initDaily = isStar ? 1.0 : 5.0;
      const initCurr = isStar ? '⭐' : '₹';

      const txResult = withTx(this.db, () => {
        const curr = this.db.prepare('SELECT coins FROM master_users WHERE user_id = ?').get(userId) as { coins: number };
        if (curr.coins < botCost) {
          this.db.prepare("UPDATE master_users SET state = '' WHERE user_id = ?").run(userId);
          return { ok: false as const, coins: curr.coins };
        }
        this.db.prepare("UPDATE master_users SET coins = coins - ?, state = '', state_data = '' WHERE user_id = ?").run(botCost, userId);
        const ins = this.db
          .prepare(
            `INSERT INTO bots (owner_id, token, bot_id_tg, bot_username, bot_name, bot_type, is_active, per_refer, min_withdraw, daily_bonus, currency, withdrawals_open, device_verify, support_username, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1, 1, ?, ?)`
          )
          .run(userId, tokenInput, tgBotId, tgUsername, tgName, botType, initPerRef, initMinWd, initDaily, initCurr, sup, now);
        return { ok: true as const, botId: Number(ins.lastInsertRowid) };
      });

      if (!txResult.ok) {
        await sendMsg(this.masterToken, chatId, `❌ Insufficient coins (${fmtNum(txResult.coins)}/${botCost}).`, this.masterMainKeyboard(userId));
        return;
      }

      await this.startChildRunner(txResult.botId);

      await sendMsg(
        this.masterToken,
        chatId,
        `🎉 <b>Your ${botTypeLabel(botType)} is LIVE!</b>\n\n` +
          `🤖 <b>Bot:</b> @${esc(tgUsername)}\n` +
          `🪙 <b>Coins Deducted:</b> <code>-${botCost}</code>\n\n` +
          `👑 Open @${esc(tgUsername)} and send <code>/admin</code> to access your Admin Panel!`,
        this.masterMainKeyboard(userId)
      );
      return;
    }

    if (!this.isMasterAdmin(userId)) {
      this.db.prepare("UPDATE master_users SET state = '', state_data = '' WHERE user_id = ?").run(userId);
      await this.sendMasterHome(userId, chatId);
      return;
    }

    // Master Admin States
    if (state === 'ma_dep_qr') {
      if (!photoFileId) {
        await sendMsg(this.masterToken, chatId, '❌ Please send a <b>QR Code Image (Photo)</b>, not text (or /cancel).');
        return;
      }
      this.setSetting('deposit_qr_file_id', photoFileId);
      this.db.prepare("UPDATE master_users SET state = '' WHERE user_id = ?").run(userId);
      await sendMsg(this.masterToken, chatId, '✅ Deposit QR Code updated!', this.masterMainKeyboard(userId));
      await this.sendMasterDepositMenu(chatId);
      return;
    }

    if (state === 'ma_dep_upi') {
      this.setSetting('deposit_upi_id', text.trim());
      this.db.prepare("UPDATE master_users SET state = '' WHERE user_id = ?").run(userId);
      await sendMsg(this.masterToken, chatId, `✅ Deposit UPI ID saved: <code>${esc(text.trim())}</code>`, this.masterMainKeyboard(userId));
      await this.sendMasterDepositMenu(chatId);
      return;
    }

    if (state === 'ma_dep_rate') {
      const parts = text.split('|').map((s) => Number(s.trim()));
      if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1]) || parts[0] <= 0 || parts[1] <= 0) {
        await sendMsg(this.masterToken, chatId, '❌ Invalid format. Send: <code>Rupees | Coins</code> (example: <code>10 | 5</code>)');
        return;
      }
      this.setSetting('deposit_rs', String(parts[0]));
      this.setSetting('deposit_coins', String(parts[1]));
      this.db.prepare("UPDATE master_users SET state = '' WHERE user_id = ?").run(userId);
      await sendMsg(
        this.masterToken,
        chatId,
        `✅ Deposit rate updated: <code>₹${fmtNum(parts[0])} = ${fmtNum(parts[1])} Coins</code>`,
        this.masterMainKeyboard(userId)
      );
      await this.sendMasterDepositMenu(chatId);
      return;
    }

    if (state === 'ma_dep_min') {
      const num = Number(text);
      if (!Number.isFinite(num) || num < 1) {
        await sendMsg(this.masterToken, chatId, '❌ Enter valid minimum deposit amount in ₹ (>= 1).');
        return;
      }
      this.setSetting('min_deposit_rs', String(num));
      this.db.prepare("UPDATE master_users SET state = '' WHERE user_id = ?").run(userId);
      await sendMsg(this.masterToken, chatId, `✅ Minimum deposit updated to ₹${fmtNum(num)}.`, this.masterMainKeyboard(userId));
      await this.sendMasterDepositMenu(chatId);
      return;
    }

    if (state === 'ma_admin_add') {
      if (!/^\d+$/.test(text.trim())) {
        await sendMsg(this.masterToken, chatId, '❌ Send numeric Telegram User ID (from @userinfobot).');
        return;
      }
      const newAdmId = Number(text.trim());
      this.db
        .prepare('INSERT OR IGNORE INTO master_admins (user_id, added_by, added_at) VALUES (?, ?, ?)')
        .run(newAdmId, userId, Math.floor(Date.now() / 1000));
      this.db.prepare("UPDATE master_users SET state = '' WHERE user_id = ?").run(userId);
      await sendMsg(this.masterToken, newAdmId, '🛡 You have been added as a <b>Master Bot Admin</b>! Send /admin to open the panel.');
      await sendMsg(this.masterToken, chatId, `✅ Added Master Admin: <code>${newAdmId}</code>`, this.masterMainKeyboard(userId));
      await this.sendMasterAdminsMenu(chatId);
      return;
    }

    if (state === 'ma_find_user') {
      const q = text.trim().replace(/^@/, '');
      const target = /^\d+$/.test(q)
        ? (this.db.prepare('SELECT * FROM master_users WHERE user_id = ?').get(Number(q)) as unknown as MasterUserRow | undefined)
        : (this.db.prepare('SELECT * FROM master_users WHERE LOWER(username) = LOWER(?)').get(q) as unknown as MasterUserRow | undefined);
      this.db.prepare("UPDATE master_users SET state = '' WHERE user_id = ?").run(userId);
      if (!target) {
        await sendMsg(this.masterToken, chatId, '❌ User not found.', this.masterMainKeyboard(userId));
        return;
      }
      await this.sendMasterUserCard(chatId, target.user_id);
      return;
    }

    if (state === 'ma_add_coins' || state === 'ma_sub_coins') {
      const targetId = Number(stateData.target_id || 0);
      const amt = Number(text);
      if (!Number.isFinite(amt) || amt <= 0) {
        await sendMsg(this.masterToken, chatId, '❌ Enter a valid positive amount.');
        return;
      }
      this.db.prepare("UPDATE master_users SET state = '', state_data = '' WHERE user_id = ?").run(userId);
      if (state === 'ma_add_coins') {
        this.db.prepare('UPDATE master_users SET coins = coins + ? WHERE user_id = ?').run(amt, targetId);
        await sendMsg(this.masterToken, targetId, `🪙 Admin added <b>+${fmtNum(amt)} Coins</b> to your account!`);
      } else {
        this.db.prepare('UPDATE master_users SET coins = MAX(0, coins - ?) WHERE user_id = ?').run(amt, targetId);
      }
      await this.sendMasterUserCard(chatId, targetId, true);
      return;
    }

    // Unlimited Force Channels (supports multiple lines!)
    if (state === 'ma_add_channel') {
      const lines = text
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      let added = 0;
      const errors: string[] = [];
      for (const line of lines) {
        const res = await resolveChannelInput(this.masterToken, line);
        if (!res.ok) {
          errors.push(`${esc(line)}: ${res.error}`);
        } else {
          this.db
            .prepare(
              'INSERT INTO master_channels (chat_id, title, invite_link, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, invite_link = excluded.invite_link'
            )
            .run(res.chatId, res.title, res.inviteLink, Math.floor(Date.now() / 1000));
          added++;
        }
      }
      this.db.prepare("UPDATE master_users SET state = '' WHERE user_id = ?").run(userId);
      const summary =
        `✅ Added <b>${added}</b> channel(s).` + (errors.length > 0 ? `\n\n⚠️ Errors:\n${errors.join('\n')}` : '');
      await sendMsg(this.masterToken, chatId, summary, this.masterMainKeyboard(userId));
      await this.sendMasterChannelsMenu(chatId, 0);
      return;
    }

    if (state.startsWith('ma_set:')) {
      const key = state.slice(7);
      const val = text.trim();
      if (
        [
          'daily_coins',
          'cost_upi_normal',
          'cost_upi_advanced',
          'cost_redeem_normal',
          'cost_redeem_advanced',
          'cost_star_normal',
          'cost_star_advanced',
          'cost_gmail_bot',
          'master_ref_coins',
        ].includes(key)
      ) {
        const num = Number(val);
        if (!Number.isFinite(num) || num < 0) {
          await sendMsg(this.masterToken, chatId, '❌ Enter a valid non-negative number.');
          return;
        }
        if (key.startsWith('cost_') && num < 1) {
          await sendMsg(this.masterToken, chatId, '❌ Bot cost must be at least 1 coin.');
          return;
        }
      }
      this.setSetting(key, val);
      this.db.prepare("UPDATE master_users SET state = '' WHERE user_id = ?").run(userId);
      await sendMsg(this.masterToken, chatId, `✅ Setting <b>${esc(key)}</b> updated to <code>${esc(val)}</code>.`, this.masterMainKeyboard(userId));
      await this.sendMasterSettingsMenu(chatId);
      return;
    }

    if (state === 'ma_bc_pick_bot') {
      const q = text.trim().replace(/^@/, '');
      const bot = /^\d+$/.test(q)
        ? (this.db.prepare('SELECT * FROM bots WHERE id = ?').get(Number(q)) as unknown as BotRow | undefined)
        : (this.db.prepare('SELECT * FROM bots WHERE LOWER(bot_username) = LOWER(?)').get(q) as unknown as BotRow | undefined);
      if (!bot) {
        await sendMsg(this.masterToken, chatId, '❌ Child bot not found. Enter valid @username or Bot ID, or /cancel.');
        return;
      }
      this.db
        .prepare("UPDATE master_users SET state = 'ma_bc_msg', state_data = ? WHERE user_id = ?")
        .run(JSON.stringify({ target: 'one_child', bot_db_id: bot.id, bot_username: bot.bot_username }), userId);
      await sendMsg(this.masterToken, chatId, `🎯 Selected <b>@${esc(bot.bot_username)}</b>.\n\nSend the broadcast message (HTML supported):`);
      return;
    }

    if (state === 'ma_bc_msg') {
      stateData.msg = text;
      this.db
        .prepare("UPDATE master_users SET state = 'ma_bc_btn', state_data = ? WHERE user_id = ?")
        .run(JSON.stringify(stateData), userId);
      await sendMsg(
        this.masterToken,
        chatId,
        '🔘 Optional URL Button:\nSend <code>Button Label | https://example.com</code>\nOr send <code>skip</code>.'
      );
      return;
    }

    if (state === 'ma_bc_btn') {
      let btn: { text: string; url: string } | null = null;
      if (text.toLowerCase() !== 'skip') {
        if (!text.includes('|')) {
          await sendMsg(this.masterToken, chatId, '❌ Invalid format. Use <code>Label | https://url.com</code> or <code>skip</code>.');
          return;
        }
        const [lbl, url] = text.split('|', 2).map((s) => s.trim());
        if (!/^https?:\/\/.+/i.test(url)) {
          await sendMsg(this.masterToken, chatId, '❌ Invalid URL.');
          return;
        }
        btn = { text: lbl, url };
      }
      stateData.btn = btn;
      this.db.prepare("UPDATE master_users SET state = '', state_data = ? WHERE user_id = ?").run(JSON.stringify(stateData), userId);
      const target = String(stateData.target || 'master');
      const targetLabel =
        target === 'all_child'
          ? '🌐 ALL Child Bots Users'
          : target === 'one_child'
            ? `🎯 Child Bot @${String(stateData.bot_username || '')}`
            : '📣 Master Bot Users';
      await sendMsg(
        this.masterToken,
        chatId,
        `📋 <b>Broadcast Preview</b>\n<b>Target:</b> ${esc(targetLabel)}\n\n${String(stateData.msg || '')}`,
        {
          inline_keyboard: [
            [{ text: '✅ Confirm & Send Broadcast', callback_data: 'ma_bc_exec', style: 'success' }],
            [{ text: '❌ Cancel', callback_data: 'ma_home', style: 'danger' }],
          ],
        }
      );
    }
  }

  private async handleMasterCallback(
    user: MasterUserRow,
    cb: { id: string; message?: { chat: { id: number }; message_id: number }; data?: string }
  ): Promise<void> {
    if (!cb.message) return;
    const userId = user.user_id;
    const chatId = cb.message.chat.id;
    const msgId = cb.message.message_id;
    const data = cb.data || '';

    if (data === 'm_check_dev') {
      if (user.device_verified === 1) {
        await answerCb(this.masterToken, cb.id, 'Verified!');
        await tgApi(this.masterToken, 'deleteMessage', { chat_id: chatId, message_id: msgId });
        await this.sendMasterHome(userId, chatId);
      } else {
        await answerCb(this.masterToken, cb.id, 'Please open Verify My Device link first!', true);
      }
      return;
    }

    if (data === 'm_dep_start') {
      await answerCb(this.masterToken, cb.id);
      const minRs = Number(this.getSetting('min_deposit_rs', '10'));
      this.db.prepare("UPDATE master_users SET state = 'm_dep_amt' WHERE user_id = ?").run(userId);
      await sendMsg(
        this.masterToken,
        chatId,
        `💵 Enter the amount you paid in <b>₹</b> (minimum <b>₹${fmtNum(minRs)}</b>):`,
        { keyboard: [[{ text: '❌ Cancel', style: 'danger' }]], resize_keyboard: true }
      );
      return;
    }

    if (data.startsWith('cb_type:')) {
      const botType = data.slice(8) as BotType;
      const cost = this.getBotTypeCost(botType);
      if (user.coins < cost) {
        await answerCb(this.masterToken, cb.id, `Need ${cost} Coins (you have ${fmtNum(user.coins)}).`, true);
        return;
      }
      await answerCb(this.masterToken, cb.id);
      this.db
        .prepare("UPDATE master_users SET state = 'await_bot_token', state_data = ? WHERE user_id = ?")
        .run(JSON.stringify({ bot_type: botType }), userId);
      await sendMsg(
        this.masterToken,
        chatId,
        `🤖 <b>Creating: ${botTypeLabel(botType)}</b>\n💰 Cost: <b>${cost} Coins</b>\n\n` +
          `<blockquote>1. Open @BotFather &amp; send <code>/newbot</code>\n` +
          `2. Paste your <b>HTTP API Token</b> below:</blockquote>`,
        { keyboard: [[{ text: '❌ Cancel', style: 'danger' }]], resize_keyboard: true }
      );
      return;
    }

    if (data.startsWith('mb_view:')) {
      const botId = Number(data.slice(8));
      const b = this.db
        .prepare(
          'SELECT b.*, (SELECT COUNT(*) FROM child_users WHERE bot_db_id = b.id) AS total_users FROM bots b WHERE b.id = ? AND b.owner_id = ?'
        )
        .get(botId, userId) as unknown as (BotRow & { total_users: number }) | undefined;
      if (!b) {
        await answerCb(this.masterToken, cb.id, 'Bot not found.', true);
        return;
      }
      await answerCb(this.masterToken, cb.id);
      const st = b.is_active === 1 ? '🟢 Active' : '⏸ Paused';
      const toggleLbl = b.is_active === 1 ? '⏸ Pause Bot' : '▶️ Resume Bot';
      const txt =
        `🤖 <b>@${esc(b.bot_username)}</b>\n\n` +
        `Template: <b>${botTypeLabel(b.bot_type)}</b>\n` +
        `Status: <b>${st}</b>\n` +
        `Users: <code>${b.total_users}</code>\n` +
        `Admin Command inside bot: <code>/admin</code>`;
      await editMsg(this.masterToken, chatId, msgId, txt, {
        inline_keyboard: [
          [{ text: '🔗 Open Bot', url: `https://t.me/${b.bot_username}`, style: 'primary' }],
          [{ text: toggleLbl, callback_data: `mb_toggle:${botId}`, style: b.is_active === 1 ? 'danger' : 'success' }],
          [
            { text: '🗑 Delete Bot', callback_data: `mb_del:${botId}`, style: 'danger' },
            { text: '⬅️ Back', callback_data: 'mb_list', style: 'primary' },
          ],
        ],
      });
      return;
    }

    if (data === 'mb_list') {
      await answerCb(this.masterToken, cb.id);
      await tgApi(this.masterToken, 'deleteMessage', { chat_id: chatId, message_id: msgId });
      await this.handleMasterMyBots(userId, chatId);
      return;
    }

    if (data.startsWith('mb_toggle:')) {
      const botId = Number(data.slice(10));
      this.db
        .prepare('UPDATE bots SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ? AND owner_id = ?')
        .run(botId, userId);
      const updated = this.db.prepare('SELECT is_active FROM bots WHERE id = ? AND owner_id = ?').get(botId, userId) as
        | { is_active: number }
        | undefined;
      if (updated?.is_active === 1) await this.startChildRunner(botId);
      else this.stopChildRunner(botId);
      await answerCb(this.masterToken, cb.id, 'Bot status updated.');
      await this.handleMasterCallback(user, { ...cb, data: `mb_view:${botId}` });
      return;
    }

    if (data.startsWith('mb_del:')) {
      const botId = Number(data.slice(7));
      await answerCb(this.masterToken, cb.id);
      await editMsg(
        this.masterToken,
        chatId,
        msgId,
        '⚠️ <b>Confirm Bot Deletion</b>\n\nAll users and data inside this child bot will be permanently deleted.',
        {
          inline_keyboard: [
            [{ text: '✅ Yes, Delete Permanently', callback_data: `mb_del_ok:${botId}`, style: 'danger' }],
            [{ text: '❌ Cancel', callback_data: `mb_view:${botId}`, style: 'primary' }],
          ],
        }
      );
      return;
    }

    if (data.startsWith('mb_del_ok:')) {
      const botId = Number(data.slice(10));
      this.stopChildRunner(botId);
      this.db.prepare('DELETE FROM bots WHERE id = ? AND owner_id = ?').run(botId, userId);
      await answerCb(this.masterToken, cb.id, 'Bot deleted.');
      await editMsg(this.masterToken, chatId, msgId, '🗑 Bot deleted successfully.');
      return;
    }

    // Master Admin Callbacks
    if (!this.isMasterAdmin(userId)) {
      await answerCb(this.masterToken, cb.id, 'Unauthorized.', true);
      return;
    }

    if (data === 'ma_home') {
      this.db.prepare("UPDATE master_users SET state = '', state_data = '' WHERE user_id = ?").run(userId);
      await answerCb(this.masterToken, cb.id);
      await this.sendMasterAdminMenu(chatId, msgId);
      return;
    }

    if (data === 'ma_stats') {
      await answerCb(this.masterToken, cb.id);
      const st = this.getStatus().stats;
      const txt =
        `📊 <b>Master Bot &amp; Ecosystem Status</b>\n\n` +
        `<blockquote>` +
        `👥 <b>Master Users:</b> <code>${st.masterUsers}</code>\n` +
        `🟢 <b>Active (24h):</b> <code>${st.activeUsers24h}</code>\n` +
        `📱 <b>Verified Devices:</b> <code>${st.verifiedDevices}</code>\n` +
        `🚫 <b>Banned Users:</b> <code>${st.bannedUsers}</code>\n` +
        `🪙 <b>Total Coins Held:</b> <code>${fmtNum(st.totalCoinsHeld)}</code>\n` +
        `💳 <b>Pending Deposits:</b> <code>${st.pendingDeposits}</code>\n\n` +
        `🤖 <b>Created Child Bots:</b> <code>${st.totalBots}</code> (<code>${st.activeBots}</code> active)\n` +
        `🌐 <b>Total Child Bot Users:</b> <code>${st.totalChildUsers}</code>` +
        `</blockquote>`;
      await editMsg(this.masterToken, chatId, msgId, txt, {
        inline_keyboard: [
          [
            { text: '🔄 Refresh', callback_data: 'ma_stats', style: 'success' },
            { text: '📋 Users List', callback_data: 'ma_users:0', style: 'primary' },
          ],
          [{ text: '⬅️ Admin Menu', callback_data: 'ma_home', style: 'primary' }],
        ],
      });
      return;
    }

    if (data === 'ma_admins') {
      await answerCb(this.masterToken, cb.id);
      await this.sendMasterAdminsMenu(chatId, msgId);
      return;
    }

    if (data === 'ma_admin_add') {
      await answerCb(this.masterToken, cb.id);
      this.db.prepare("UPDATE master_users SET state = 'ma_admin_add' WHERE user_id = ?").run(userId);
      await sendMsg(this.masterToken, chatId, '👮 Send the numeric <b>Telegram User ID</b> to add as Master Admin:');
      return;
    }

    if (data.startsWith('ma_admin_del:')) {
      const remId = Number(data.slice(13));
      if (this.primaryAdminIds.includes(remId)) {
        await answerCb(this.masterToken, cb.id, 'Cannot remove primary owner.', true);
        return;
      }
      this.db.prepare('DELETE FROM master_admins WHERE user_id = ?').run(remId);
      await answerCb(this.masterToken, cb.id, 'Admin removed.');
      await this.sendMasterAdminsMenu(chatId, msgId);
      return;
    }

    if (data === 'ma_deposit') {
      await answerCb(this.masterToken, cb.id);
      await this.sendMasterDepositMenu(chatId, msgId);
      return;
    }

    if (data === 'ma_dep_qr') {
      await answerCb(this.masterToken, cb.id);
      this.db.prepare("UPDATE master_users SET state = 'ma_dep_qr' WHERE user_id = ?").run(userId);
      await sendMsg(this.masterToken, chatId, '🖼 Send your <b>Deposit QR Code Image (Photo)</b> now (or /cancel):');
      return;
    }

    if (data === 'ma_dep_upi') {
      await answerCb(this.masterToken, cb.id);
      this.db.prepare("UPDATE master_users SET state = 'ma_dep_upi' WHERE user_id = ?").run(userId);
      await sendMsg(this.masterToken, chatId, '🏦 Send your <b>Deposit UPI ID</b> (e.g. <code>merchant@ybl</code>):');
      return;
    }

    if (data === 'ma_dep_rate') {
      await answerCb(this.masterToken, cb.id);
      this.db.prepare("UPDATE master_users SET state = 'ma_dep_rate' WHERE user_id = ?").run(userId);
      await sendMsg(this.masterToken, chatId, '💱 Send rate in format <code>Rupees | Coins</code>\nExample: <code>10 | 5</code> (means ₹10 = 5 Coins)');
      return;
    }

    if (data === 'ma_dep_min') {
      await answerCb(this.masterToken, cb.id);
      this.db.prepare("UPDATE master_users SET state = 'ma_dep_min' WHERE user_id = ?").run(userId);
      await sendMsg(this.masterToken, chatId, '📉 Enter minimum deposit amount in ₹ (e.g. <code>10</code>):');
      return;
    }

    if (data === 'ma_dep_tog') {
      const cur = this.getSetting('deposit_enabled', '1');
      this.setSetting('deposit_enabled', cur === '1' ? '0' : '1');
      await answerCb(this.masterToken, cb.id, 'Deposit status toggled.');
      await this.sendMasterDepositMenu(chatId, msgId);
      return;
    }

    if (data.startsWith('ma_deps:')) {
      await answerCb(this.masterToken, cb.id);
      const offset = Math.max(0, Number(data.slice(8)));
      const d = this.db
        .prepare(
          `SELECT d.*, u.first_name, u.username FROM deposits d
           LEFT JOIN master_users u ON u.user_id = d.user_id
           WHERE d.status = 'pending' ORDER BY d.id ASC LIMIT 1 OFFSET ?`
        )
        .get(offset) as unknown as DepositRow | undefined;
      const tot = Number((this.db.prepare("SELECT COUNT(*) AS c FROM deposits WHERE status = 'pending'").get() as { c: number }).c);
      if (!d) {
        await editMsg(this.masterToken, chatId, msgId, '💳 <b>Pending Deposits</b>\n\nNo pending deposits!', {
          inline_keyboard: [[{ text: '⬅️ Deposit Menu', callback_data: 'ma_deposit', style: 'primary' }]],
        });
        return;
      }
      const uname = d.username ? `@${esc(d.username)}` : esc(d.first_name || 'User');
      const txt =
        `💳 <b>Pending Deposit (${offset + 1}/${tot})</b>\n\n` +
        `<blockquote>` +
        `🎫 ID: <code>#${d.id}</code>\n` +
        `👤 User: <b>${uname}</b> (<code>${d.user_id}</code>)\n` +
        `💵 Paid: <b>₹${fmtNum(d.amount_rs)}</b>\n` +
        `🪙 Coins: <b>+${fmtNum(d.coins)}</b>\n` +
        `🧾 UTR: <code>${esc(d.utr)}</code>` +
        `</blockquote>`;
      const rows: Array<Array<{ text: string; callback_data: string; style?: TgButtonStyle }>> = [
        [
          { text: `✅ Approve (+${fmtNum(d.coins)}🪙)`, callback_data: `ma_dep_ok:${d.id}`, style: 'success' },
          { text: '❌ Reject', callback_data: `ma_dep_no:${d.id}`, style: 'danger' },
        ],
      ];
      const nav: Array<{ text: string; callback_data: string; style?: TgButtonStyle }> = [];
      if (offset > 0) nav.push({ text: '⬅️ Prev', callback_data: `ma_deps:${offset - 1}`, style: 'primary' });
      if (offset + 1 < tot) nav.push({ text: 'Next ➡️', callback_data: `ma_deps:${offset + 1}`, style: 'primary' });
      if (nav.length > 0) rows.push(nav);
      rows.push([{ text: '⬅️ Deposit Menu', callback_data: 'ma_deposit', style: 'primary' }]);
      await editMsg(this.masterToken, chatId, msgId, txt, { inline_keyboard: rows });
      return;
    }

    if (data.startsWith('ma_dep_ok:') || data.startsWith('ma_dep_no:')) {
      const isOk = data.startsWith('ma_dep_ok:');
      const depId = Number(data.slice(10));
      const res = withTx(this.db, () => {
        const d = this.db.prepare('SELECT * FROM deposits WHERE id = ?').get(depId) as unknown as DepositRow | undefined;
        if (!d || d.status !== 'pending') return null;
        this.db
          .prepare('UPDATE deposits SET status = ?, processed_by = ?, processed_at = ? WHERE id = ?')
          .run(isOk ? 'approved' : 'rejected', userId, Math.floor(Date.now() / 1000), depId);
        if (isOk) {
          this.db.prepare('UPDATE master_users SET coins = coins + ? WHERE user_id = ?').run(d.coins, d.user_id);
        }
        return d;
      });
      if (!res) {
        await answerCb(this.masterToken, cb.id, 'Already processed.', true);
        return;
      }
      await answerCb(this.masterToken, cb.id, isOk ? 'Coins credited!' : 'Rejected!');
      const statusTxt = isOk
        ? `✅ <b>Deposit #${depId} Approved</b> (+${fmtNum(res.coins)} Coins to <code>${res.user_id}</code>)`
        : `❌ <b>Deposit #${depId} Rejected</b>`;
      // Message could be photo or text
      const editAttempt = await editMsg(this.masterToken, chatId, msgId, statusTxt);
      if (!editAttempt.ok) {
        await sendMsg(this.masterToken, chatId, statusTxt);
      }
      await sendMsg(
        this.masterToken,
        res.user_id,
        isOk
          ? `✅ <b>Deposit Approved!</b>\n\n🎫 Request #${depId}\n💵 ₹${fmtNum(res.amount_rs)} verified.\n🪙 <b>+${fmtNum(res.coins)} Coins</b> added to your account!`
          : `❌ <b>Deposit Rejected</b>\n\n🎫 Request #${depId} (₹${fmtNum(res.amount_rs)}) could not be verified. Contact support if needed.`
      );
      return;
    }

    if (data === 'ma_find_user') {
      await answerCb(this.masterToken, cb.id);
      this.db.prepare("UPDATE master_users SET state = 'ma_find_user' WHERE user_id = ?").run(userId);
      await sendMsg(this.masterToken, chatId, "🔍 Send the user's <b>Telegram ID</b> or <b>@username</b> (or /cancel):");
      return;
    }

    if (data.startsWith('ma_users:')) {
      await answerCb(this.masterToken, cb.id);
      const page = Math.max(0, Number(data.slice(9)));
      const limit = 10;
      const offset = page * limit;
      const rows = this.db
        .prepare(
          `SELECT u.*, (SELECT COUNT(*) FROM bots b WHERE b.owner_id = u.user_id) AS bot_cnt
           FROM master_users u ORDER BY u.last_active_at DESC LIMIT ? OFFSET ?`
        )
        .all(limit, offset) as unknown as Array<MasterUserRow & { bot_cnt: number }>;

      const kbRows: Array<Array<{ text: string; callback_data: string }>> = rows.map((r) => {
        const stIcon = r.is_banned === 1 ? '🚫' : '🟢';
        const un = r.username ? `@${r.username}` : r.first_name;
        return [{ text: `${stIcon} ${un} | ${fmtNum(r.coins)}🪙 | ${r.bot_cnt} bots`, callback_data: `ma_u_view:${r.user_id}` }];
      });
      const nav: Array<{ text: string; callback_data: string }> = [];
      if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `ma_users:${page - 1}` });
      if (rows.length === limit) nav.push({ text: 'Next ➡️', callback_data: `ma_users:${page + 1}` });
      if (nav.length > 0) kbRows.push(nav);
      kbRows.push([{ text: '⬅️ Admin Menu', callback_data: 'ma_home' }]);

      await editMsg(this.masterToken, chatId, msgId, `📋 <b>Users List (Page ${page + 1})</b>`, { inline_keyboard: kbRows });
      return;
    }

    if (data.startsWith('ma_u_view:')) {
      await answerCb(this.masterToken, cb.id);
      await this.sendMasterUserCard(chatId, Number(data.slice(10)), false, msgId);
      return;
    }

    if (data.startsWith('ma_u_add:') || data.startsWith('ma_u_sub:')) {
      await answerCb(this.masterToken, cb.id);
      const isAdd = data.startsWith('ma_u_add:');
      const tid = Number(data.slice(9));
      this.db
        .prepare('UPDATE master_users SET state = ?, state_data = ? WHERE user_id = ?')
        .run(isAdd ? 'ma_add_coins' : 'ma_sub_coins', JSON.stringify({ target_id: tid }), userId);
      await sendMsg(this.masterToken, chatId, `${isAdd ? '➕' : '➖'} Enter coin amount for user <code>${tid}</code>:`);
      return;
    }

    if (data.startsWith('ma_u_ban:')) {
      const tid = Number(data.slice(9));
      if (this.isMasterAdmin(tid)) {
        await answerCb(this.masterToken, cb.id, 'Cannot ban Master Admin.', true);
        return;
      }
      this.db.prepare('UPDATE master_users SET is_banned = CASE WHEN is_banned = 1 THEN 0 ELSE 1 END WHERE user_id = ?').run(tid);
      await answerCb(this.masterToken, cb.id, 'Updated ban status.');
      await this.sendMasterUserCard(chatId, tid, false, msgId);
      return;
    }

    if (data.startsWith('ma_channels:')) {
      await answerCb(this.masterToken, cb.id);
      await this.sendMasterChannelsMenu(chatId, Number(data.slice(12)), msgId);
      return;
    }

    if (data === 'ma_channels') {
      await answerCb(this.masterToken, cb.id);
      await this.sendMasterChannelsMenu(chatId, 0, msgId);
      return;
    }

    if (data === 'ma_ch_add') {
      await answerCb(this.masterToken, cb.id);
      this.db.prepare("UPDATE master_users SET state = 'ma_add_channel' WHERE user_id = ?").run(userId);
      await sendMsg(
        this.masterToken,
        chatId,
        '📢 <b>Add Unlimited Force Channels</b>\n\n' +
          'Make this Master Bot <b>Admin</b> in your channel(s), then send:\n' +
          '• <code>@ChannelUsername</code>\n' +
          '• Private: <code>-1001234567890 | https://t.me/+InviteLink</code>\n' +
          '• Or send <b>multiple channels</b> (one per line) at once!'
      );
      return;
    }

    if (data.startsWith('ma_ch_del:')) {
      const cid = Number(data.slice(10));
      this.db.prepare('DELETE FROM master_channels WHERE id = ?').run(cid);
      await answerCb(this.masterToken, cb.id, 'Channel removed.');
      await this.sendMasterChannelsMenu(chatId, 0, msgId);
      return;
    }

    if (data === 'ma_settings') {
      await answerCb(this.masterToken, cb.id);
      await this.sendMasterSettingsMenu(chatId, msgId);
      return;
    }

    if (data.startsWith('ma_set:')) {
      await answerCb(this.masterToken, cb.id);
      const key = data.slice(7);
      this.db.prepare('UPDATE master_users SET state = ? WHERE user_id = ?').run(`ma_set:${key}`, userId);
      await sendMsg(this.masterToken, chatId, `✏️ Enter new value for <b>${esc(key)}</b> (or /cancel):`);
      return;
    }

    if (data === 'ma_toggle_maint') {
      const curr = this.getSetting('maintenance', '0');
      this.setSetting('maintenance', curr === '1' ? '0' : '1');
      await answerCb(this.masterToken, cb.id, 'Maintenance mode toggled.');
      await this.sendMasterSettingsMenu(chatId, msgId);
      return;
    }

    if (data === 'ma_toggle_dev') {
      const curr = this.getSetting('master_device_verify', '1');
      this.setSetting('master_device_verify', curr === '1' ? '0' : '1');
      await answerCb(this.masterToken, cb.id, 'Device verification toggled.');
      await this.sendMasterSettingsMenu(chatId, msgId);
      return;
    }

    if (data === 'ma_broadcast') {
      await answerCb(this.masterToken, cb.id);
      await editMsg(this.masterToken, chatId, msgId, '📣 <b>Broadcast Center</b>\n\nChoose target:', {
        inline_keyboard: [
          [{ text: '📣 Master Bot Users', callback_data: 'ma_bc_t:master', style: 'primary' }],
          [{ text: '🌐 ALL Child Bots (Every User)', callback_data: 'ma_bc_t:all_child', style: 'success' }],
          [{ text: '🎯 Specific Child Bot', callback_data: 'ma_bc_t:one_child', style: 'primary' }],
          [{ text: '⬅️ Admin Menu', callback_data: 'ma_home', style: 'danger' }],
        ],
      });
      return;
    }

    if (data.startsWith('ma_bc_t:')) {
      await answerCb(this.masterToken, cb.id);
      const target = data.slice(8);
      if (target === 'one_child') {
        this.db.prepare("UPDATE master_users SET state = 'ma_bc_pick_bot' WHERE user_id = ?").run(userId);
        await sendMsg(this.masterToken, chatId, '🎯 Enter Child Bot <b>@username</b> or numeric <b>Bot ID</b>:');
      } else {
        this.db
          .prepare("UPDATE master_users SET state = 'ma_bc_msg', state_data = ? WHERE user_id = ?")
          .run(JSON.stringify({ target }), userId);
        await sendMsg(this.masterToken, chatId, '📝 Send your broadcast message (HTML supported):');
      }
      return;
    }

    if (data === 'ma_bc_exec') {
      let sd: { target?: string; bot_db_id?: number; msg?: string; btn?: { text: string; url: string } | null } = {};
      try {
        sd = JSON.parse(user.state_data || '{}');
      } catch {
        sd = {};
      }
      if (!sd.msg) {
        await answerCb(this.masterToken, cb.id, 'No pending broadcast.', true);
        return;
      }
      await answerCb(this.masterToken, cb.id, 'Starting broadcast...');
      this.db.prepare("UPDATE master_users SET state_data = '' WHERE user_id = ?").run(userId);
      const markup = sd.btn ? { inline_keyboard: [[sd.btn]] } : undefined;
      const target = sd.target || 'master';
      await editMsg(this.masterToken, chatId, msgId, '⏳ <b>Broadcasting in progress...</b>');

      if (target === 'master') {
        const uids = (this.db.prepare('SELECT user_id FROM master_users WHERE is_banned = 0').all() as Array<{ user_id: number }>).map(
          (r) => r.user_id
        );
        const res = await executeBroadcast(this.masterToken, uids, sd.msg, markup);
        await sendMsg(this.masterToken, chatId, `✅ <b>Master Broadcast Complete</b>\n\n📤 Sent: <code>${res.sent}</code>\n❌ Failed: <code>${res.failed}</code>`);
      } else if (target === 'one_child') {
        const bot = this.db.prepare('SELECT token, bot_username FROM bots WHERE id = ?').get(Number(sd.bot_db_id || 0)) as
          | { token: string; bot_username: string }
          | undefined;
        if (bot) {
          const uids = (
            this.db
              .prepare('SELECT user_id FROM child_users WHERE bot_db_id = ? AND is_banned = 0')
              .all(Number(sd.bot_db_id || 0)) as Array<{ user_id: number }>
          ).map((r) => r.user_id);
          const res = await executeBroadcast(bot.token, uids, sd.msg, markup);
          await sendMsg(
            this.masterToken,
            chatId,
            `✅ <b>Broadcast Complete (@${esc(bot.bot_username)})</b>\n\n📤 Sent: <code>${res.sent}</code>\n❌ Failed: <code>${res.failed}</code>`
          );
        }
      } else if (target === 'all_child') {
        const bots = this.db.prepare('SELECT id, token FROM bots WHERE is_active = 1').all() as Array<{ id: number; token: string }>;
        let totalSent = 0;
        let totalFailed = 0;
        let botsCount = 0;
        const uStmt = this.db.prepare('SELECT user_id FROM child_users WHERE bot_db_id = ? AND is_banned = 0');
        for (const b of bots) {
          const uids = (uStmt.all(b.id) as Array<{ user_id: number }>).map((r) => r.user_id);
          if (uids.length === 0) continue;
          botsCount++;
          const res = await executeBroadcast(b.token, uids, sd.msg, markup);
          totalSent += res.sent;
          totalFailed += res.failed;
        }
        await sendMsg(
          this.masterToken,
          chatId,
          `🌐 <b>Global Child-Bots Broadcast Complete</b>\n\n🤖 Bots: <code>${botsCount}</code>\n📤 Sent: <code>${totalSent}</code>\n❌ Failed: <code>${totalFailed}</code>`
        );
      }
      return;
    }

    if (data.startsWith('ma_bots:')) {
      await answerCb(this.masterToken, cb.id);
      const page = Math.max(0, Number(data.slice(8)));
      const limit = 10;
      const offset = page * limit;
      const bots = this.db
        .prepare(
          `SELECT b.*, (SELECT COUNT(*) FROM child_users cu WHERE cu.bot_db_id = b.id) AS ucnt
           FROM bots b ORDER BY b.id DESC LIMIT ? OFFSET ?`
        )
        .all(limit, offset) as unknown as Array<BotRow & { ucnt: number }>;

      const kbRows: Array<Array<{ text: string; callback_data: string; style?: TgButtonStyle }>> = bots.map((b) => [
        {
          text: `${b.is_active === 1 ? '🟢' : '🚫'} #${b.id} @${b.bot_username} · ${botTypeLabel(b.bot_type)} (${b.ucnt})`,
          callback_data: `ma_bot_v:${b.id}`,
          style: b.is_active === 1 ? 'primary' : 'danger',
        },
      ]);
      const nav: Array<{ text: string; callback_data: string; style?: TgButtonStyle }> = [];
      if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `ma_bots:${page - 1}`, style: 'primary' });
      if (bots.length === limit) nav.push({ text: 'Next ➡️', callback_data: `ma_bots:${page + 1}`, style: 'primary' });
      if (nav.length > 0) kbRows.push(nav);
      kbRows.push([{ text: '⬅️ Admin Menu', callback_data: 'ma_home', style: 'primary' }]);
      await editMsg(this.masterToken, chatId, msgId, '🤖 <b>All Created Child Bots</b>', { inline_keyboard: kbRows });
      return;
    }

    if (data.startsWith('ma_bot_v:')) {
      await answerCb(this.masterToken, cb.id);
      await this.sendMasterBotCard(chatId, Number(data.slice(9)), msgId);
      return;
    }

    if (data.startsWith('ma_bot_tog:')) {
      const bid = Number(data.slice(11));
      this.db.prepare('UPDATE bots SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ?').run(bid);
      const updated = this.db.prepare('SELECT is_active FROM bots WHERE id = ?').get(bid) as { is_active: number } | undefined;
      if (updated?.is_active === 1) await this.startChildRunner(bid);
      else this.stopChildRunner(bid);
      await answerCb(this.masterToken, cb.id, 'Child bot status updated.');
      await this.sendMasterBotCard(chatId, bid, msgId);
      return;
    }

    if (data.startsWith('ma_bot_del:')) {
      const bid = Number(data.slice(11));
      this.stopChildRunner(bid);
      this.db.prepare('DELETE FROM bots WHERE id = ?').run(bid);
      await answerCb(this.masterToken, cb.id, 'Bot deleted.');
      await editMsg(this.masterToken, chatId, msgId, `🗑 Child bot #${bid} deleted.`, {
        inline_keyboard: [[{ text: '🤖 All Child Bots', callback_data: 'ma_bots:0', style: 'primary' }]],
      });
    }
  }

  private async sendMasterAdminMenu(chatId: number, editMsgId?: number): Promise<void> {
    const dailyCoins = this.getSetting('daily_coins', '2');
    const pendDeps = Number((this.db.prepare("SELECT COUNT(*) AS c FROM deposits WHERE status = 'pending'").get() as { c: number }).c);
    const txt =
      `🛡 <b>Master Admin Panel</b>\n\n` +
      `<blockquote>🎁 Daily Bonus: <code>${dailyCoins} Coins</code> · 💳 Pending Deposits: <code>${pendDeps}</code></blockquote>\n` +
      `<i>Manage users, admins, deposits &amp; QR, unlimited force channels, bot prices, device verification &amp; broadcasts.</i>`;
    const kb = {
      inline_keyboard: [
        [
          { text: '📊 Users & Status', callback_data: 'ma_stats', style: 'primary' },
          { text: '🔍 Find User', callback_data: 'ma_find_user', style: 'primary' },
        ],
        [
          { text: '📋 Users List', callback_data: 'ma_users:0', style: 'primary' },
          { text: '🤖 Child Bots', callback_data: 'ma_bots:0', style: 'primary' },
        ],
        [
          { text: `💳 Deposits & QR (${pendDeps})`, callback_data: 'ma_deposit', style: 'success' },
          { text: '👮 Manage Admins', callback_data: 'ma_admins', style: 'primary' },
        ],
        [
          { text: '📢 Force Channels', callback_data: 'ma_channels:0', style: 'primary' },
          { text: '📣 Broadcast', callback_data: 'ma_broadcast', style: 'success' },
        ],
        [{ text: '🪙 Coins, Prices & Device Verify', callback_data: 'ma_settings', style: 'primary' }],
      ],
    };
    if (editMsgId) await editMsg(this.masterToken, chatId, editMsgId, txt, kb);
    else await sendMsg(this.masterToken, chatId, txt, kb);
  }

  private async sendMasterAdminsMenu(chatId: number, editMsgId?: number): Promise<void> {
    const added = this.db
      .prepare('SELECT user_id FROM master_admins ORDER BY added_at ASC')
      .all() as unknown as Array<{ user_id: number }>;
    const txt =
      `👮 <b>Master Bot Admins</b>\n\n` +
      `<blockquote>👑 Primary Owners: <code>${this.primaryAdminIds.join(', ')}</code>\n` +
      `👮 Added Admins: <code>${added.length}</code></blockquote>`;
    const rows: Array<Array<{ text: string; callback_data: string; style?: TgButtonStyle }>> = added.map((a) => [
      { text: `👮 Admin ${a.user_id}`, callback_data: `ma_u_view:${a.user_id}`, style: 'primary' },
      { text: '🗑 Remove', callback_data: `ma_admin_del:${a.user_id}`, style: 'danger' },
    ]);
    rows.push([{ text: '➕ Add Admin', callback_data: 'ma_admin_add', style: 'success' }]);
    rows.push([{ text: '⬅️ Admin Menu', callback_data: 'ma_home', style: 'primary' }]);
    if (editMsgId) await editMsg(this.masterToken, chatId, editMsgId, txt, { inline_keyboard: rows });
    else await sendMsg(this.masterToken, chatId, txt, { inline_keyboard: rows });
  }

  private async sendMasterDepositMenu(chatId: number, editMsgId?: number): Promise<void> {
    const enabledOn = this.getSetting('deposit_enabled', '1') === '1';
    const enabled = enabledOn ? '🟢 ON' : '🔴 OFF';
    const rs = this.getSetting('deposit_rs', '10');
    const coins = this.getSetting('deposit_coins', '5');
    const minRs = this.getSetting('min_deposit_rs', '10');
    const hasQr = this.getSetting('deposit_qr_file_id', '') !== '' ? '✅ Set' : '❌ Not Set';
    const upi = this.getSetting('deposit_upi_id', '') || 'Not Set';
    const pend = Number((this.db.prepare("SELECT COUNT(*) AS c FROM deposits WHERE status = 'pending'").get() as { c: number }).c);

    const txt =
      `💳 <b>Deposit &amp; QR Code Settings</b>\n\n` +
      `<blockquote>` +
      `Status: <b>${enabled}</b>\n` +
      `💱 Rate: <code>₹${rs} = ${coins} Coins</code>\n` +
      `📉 Min Deposit: <code>₹${minRs}</code>\n` +
      `🖼 Deposit QR Photo: <b>${hasQr}</b>\n` +
      `🏦 Deposit UPI ID: <code>${esc(upi)}</code>\n` +
      `⏳ Pending Requests: <code>${pend}</code>` +
      `</blockquote>`;
    const kb = {
      inline_keyboard: [
        [{ text: `⏳ Pending Deposits (${pend})`, callback_data: 'ma_deps:0', style: 'success' }],
        [
          { text: '🖼 Set Deposit QR', callback_data: 'ma_dep_qr', style: 'primary' },
          { text: '🏦 Set UPI ID', callback_data: 'ma_dep_upi', style: 'primary' },
        ],
        [
          { text: `💱 Rate (₹${rs}=${coins}🪙)`, callback_data: 'ma_dep_rate', style: 'primary' },
          { text: `📉 Min (₹${minRs})`, callback_data: 'ma_dep_min', style: 'primary' },
        ],
        [{ text: `🔌 Deposits: ${enabled}`, callback_data: 'ma_dep_tog', style: enabledOn ? 'success' : 'danger' }],
        [{ text: '⬅️ Admin Menu', callback_data: 'ma_home', style: 'primary' }],
      ],
    };
    if (editMsgId) await editMsg(this.masterToken, chatId, editMsgId, txt, kb);
    else await sendMsg(this.masterToken, chatId, txt, kb);
  }

  private async sendMasterBotCard(chatId: number, bid: number, msgId: number): Promise<void> {
    const b = this.db
      .prepare('SELECT b.*, (SELECT COUNT(*) FROM child_users WHERE bot_db_id = b.id) AS ucnt FROM bots b WHERE b.id = ?')
      .get(bid) as unknown as (BotRow & { ucnt: number }) | undefined;
    if (!b) return;
    const st = b.is_active === 1 ? '🟢 Active' : '🚫 Suspended';
    const toggleLbl = b.is_active === 1 ? '🚫 Suspend Bot' : '✅ Activate Bot';
    const txt =
      `🤖 <b>Child Bot #${b.id}</b>\n\n` +
      `<blockquote>` +
      `Username: @${esc(b.bot_username)}\n` +
      `Template: <b>${botTypeLabel(b.bot_type)}</b>\n` +
      `Owner ID: <code>${b.owner_id}</code>\n` +
      `Users: <code>${b.ucnt}</code>\n` +
      `Status: <b>${st}</b>` +
      `</blockquote>`;
    await editMsg(this.masterToken, chatId, msgId, txt, {
      inline_keyboard: [
        [
          { text: toggleLbl, callback_data: `ma_bot_tog:${bid}`, style: b.is_active === 1 ? 'danger' : 'success' },
          { text: '🗑 Delete Bot', callback_data: `ma_bot_del:${bid}`, style: 'danger' },
        ],
        [
          { text: '👤 Inspect Owner', callback_data: `ma_u_view:${b.owner_id}`, style: 'primary' },
          { text: '⬅️ Bots List', callback_data: 'ma_bots:0', style: 'primary' },
        ],
      ],
    });
  }

  private async sendMasterUserCard(chatId: number, targetId: number, sendNew = false, editMsgId?: number): Promise<void> {
    const u = this.db.prepare('SELECT * FROM master_users WHERE user_id = ?').get(targetId) as unknown as MasterUserRow | undefined;
    if (!u) return;
    const botsCnt = Number((this.db.prepare('SELECT COUNT(*) AS c FROM bots WHERE owner_id = ?').get(targetId) as { c: number }).c);
    const st = u.is_banned === 1 ? '🚫 Banned' : '🟢 Active';
    const banLbl = u.is_banned === 1 ? '✅ Unban User' : '🚫 Ban User';
    const txt =
      `👤 <b>User Profile</b>\n\n` +
      `<blockquote>` +
      `ID: <code>${u.user_id}</code>\n` +
      `Name: <b>${esc(u.first_name)}</b>\n` +
      `Username: ${u.username ? '@' + esc(u.username) : '<i>None</i>'}\n` +
      `Status: <b>${st}</b>\n` +
      `📱 Device: ${u.device_verified === 1 ? '✅ Verified' : 'Unverified'}\n` +
      `🪙 Coins: <code>${fmtNum(u.coins)}</code>\n` +
      `🤖 Bots Created: <code>${botsCnt}</code>\n` +
      `👥 Referrals: <code>${u.total_refs}</code>\n` +
      `🕒 Last Active: ${fmtDateShort(u.last_active_at)}` +
      `</blockquote>`;
    const kb = {
      inline_keyboard: [
        [
          { text: '➕ Add Coins', callback_data: `ma_u_add:${targetId}`, style: 'success' },
          { text: '➖ Deduct Coins', callback_data: `ma_u_sub:${targetId}`, style: 'danger' },
        ],
        [
          { text: banLbl, callback_data: `ma_u_ban:${targetId}`, style: u.is_banned === 1 ? 'success' : 'danger' },
          { text: '⬅️ Admin Menu', callback_data: 'ma_home', style: 'primary' },
        ],
      ],
    };
    if (editMsgId && !sendNew) await editMsg(this.masterToken, chatId, editMsgId, txt, kb);
    else await sendMsg(this.masterToken, chatId, txt, kb);
  }

  private async sendMasterChannelsMenu(chatId: number, page = 0, editMsgId?: number): Promise<void> {
    const total = Number((this.db.prepare('SELECT COUNT(*) AS c FROM master_channels').get() as { c: number }).c);
    const limit = 8;
    const offset = Math.max(0, page) * limit;
    const chs = this.db
      .prepare('SELECT * FROM master_channels ORDER BY id ASC LIMIT ? OFFSET ?')
      .all(limit, offset) as unknown as ChannelRow[];
    const txt = `📢 <b>Master Force Join Channels (${total} total)</b>\n\nAdd as many channels as you want:`;
    const rows: Array<Array<{ text: string; url?: string; callback_data?: string; style?: TgButtonStyle }>> = chs.map((c) => [
      { text: `📢 ${c.title}`, url: c.invite_link, style: 'primary' },
      { text: '🗑 Remove', callback_data: `ma_ch_del:${c.id}`, style: 'danger' },
    ]);
    const nav: Array<{ text: string; callback_data: string; style?: TgButtonStyle }> = [];
    if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `ma_channels:${page - 1}`, style: 'primary' });
    if (offset + chs.length < total) nav.push({ text: 'Next ➡️', callback_data: `ma_channels:${page + 1}`, style: 'primary' });
    if (nav.length > 0) rows.push(nav);
    rows.push([{ text: '➕ Add Force Channel(s)', callback_data: 'ma_ch_add', style: 'success' }]);
    rows.push([{ text: '⬅️ Admin Menu', callback_data: 'ma_home', style: 'primary' }]);
    if (editMsgId) await editMsg(this.masterToken, chatId, editMsgId, txt, { inline_keyboard: rows });
    else await sendMsg(this.masterToken, chatId, txt, { inline_keyboard: rows });
  }

  private async sendMasterSettingsMenu(chatId: number, editMsgId?: number): Promise<void> {
    const daily = this.getSetting('daily_coins', '2');
    const cUpiN = this.getSetting('cost_upi_normal', '5');
    const cUpiA = this.getSetting('cost_upi_advanced', '10');
    const cRedN = this.getSetting('cost_redeem_normal', '5');
    const cRedA = this.getSetting('cost_redeem_advanced', '10');
    const cStarN = this.getSetting('cost_star_normal', '5');
    const cStarA = this.getSetting('cost_star_advanced', '10');
    const cGmail = this.getSetting('cost_gmail_bot', '10');
    const ref = this.getSetting('master_ref_coins', '1');
    const sup = this.getSetting('support_username', '@Support');
    const maintOn = this.getSetting('maintenance', '0') === '1';
    const devOn = this.getSetting('master_device_verify', '1') === '1';
    const maint = maintOn ? '🔴 ON' : '🟢 OFF';
    const dev = devOn ? '🟢 ON' : '🔴 OFF';

    const txt =
      `🪙 <b>Coins, Bot Prices &amp; Verification</b>\n\n` +
      `<blockquote>` +
      `🎁 Daily Claim Coins: <code>${daily}</code>\n` +
      `👥 Master Refer Bonus: <code>${ref}</code>\n` +
      `💸 Normal UPI Bot Cost: <code>${cUpiN}🪙</code>\n` +
      `🚀 Advanced UPI Bot Cost: <code>${cUpiA}🪙</code>\n` +
      `🎟 Normal Redeem Bot Cost: <code>${cRedN}🪙</code>\n` +
      `💎 Advanced Redeem Bot Cost: <code>${cRedA}🪙</code>\n` +
      `⭐ Normal Star Bot Cost: <code>${cStarN}🪙</code>\n` +
      `🌟 Advanced Star Bot Cost: <code>${cStarA}🪙</code>\n` +
      `📧 Gmail Buy &amp; Sell Bot Cost: <code>${cGmail}🪙</code>\n` +
      `📱 Device Verification: <b>${dev}</b>\n` +
      `🆘 Support: ${esc(sup)} · 🛠 Maint: <b>${maint}</b>` +
      `</blockquote>`;

    const kb = {
      inline_keyboard: [
        [
          { text: `🎁 Daily (${daily})`, callback_data: 'ma_set:daily_coins', style: 'success' },
          { text: `👥 Refer (${ref})`, callback_data: 'ma_set:master_ref_coins', style: 'primary' },
        ],
        [
          { text: `💸 Normal UPI (${cUpiN})`, callback_data: 'ma_set:cost_upi_normal', style: 'primary' },
          { text: `🚀 Adv UPI (${cUpiA})`, callback_data: 'ma_set:cost_upi_advanced', style: 'success' },
        ],
        [
          { text: `🎟 Normal Redeem (${cRedN})`, callback_data: 'ma_set:cost_redeem_normal', style: 'primary' },
          { text: `💎 Adv Redeem (${cRedA})`, callback_data: 'ma_set:cost_redeem_advanced', style: 'success' },
        ],
        [
          { text: `⭐ Normal Star (${cStarN})`, callback_data: 'ma_set:cost_star_normal', style: 'primary' },
          { text: `🌟 Adv Star (${cStarA})`, callback_data: 'ma_set:cost_star_advanced', style: 'success' },
        ],
        [{ text: `📧 Gmail Buy & Sell Bot (${cGmail})`, callback_data: 'ma_set:cost_gmail_bot', style: 'primary' }],
        [
          { text: `📱 Device Verify: ${dev}`, callback_data: 'ma_toggle_dev', style: devOn ? 'success' : 'danger' },
          { text: `🛠 Maint: ${maint}`, callback_data: 'ma_toggle_maint', style: maintOn ? 'danger' : 'success' },
        ],
        [{ text: '🆘 Support @', callback_data: 'ma_set:support_username', style: 'primary' }],
        [{ text: '⬅️ Admin Menu', callback_data: 'ma_home', style: 'primary' }],
      ],
    };
    if (editMsgId) await editMsg(this.masterToken, chatId, editMsgId, txt, kb);
    else await sendMsg(this.masterToken, chatId, txt, kb);
  }

  // ============================================================================
  // CHILD BOT ENGINE (UPI, REDEEM CODE, TELEGRAM STAR & GMAIL BUY/SELL)
  // ============================================================================
  private childMainKeyboard(bot: BotRow, userId: number): Record<string, unknown> {
    const isRedeem = isRedeemBotType(bot.bot_type);
    const isStar = isStarBotType(bot.bot_type);
    const isGmail = isGmailBotType(bot.bot_type);
    const isAdvanced = isAdvancedBotType(bot.bot_type);

    const rows: Array<Array<{ text: string; style?: TgButtonStyle }>> = [];
    if (isGmail) {
      rows.push([
        { text: '🛒 Buy Gmail', style: 'success' },
        { text: '📤 Sell Gmail', style: 'primary' },
      ]);
      rows.push([
        { text: '💳 Deposit', style: 'success' },
        { text: '💰 Balance', style: 'primary' },
      ]);
      rows.push([
        { text: '💸 Withdraw', style: 'success' },
        { text: '🏦 Set UPI ID', style: 'primary' },
      ]);
      rows.push([
        { text: '👥 Refer & Earn', style: 'primary' },
        { text: '🎁 Daily Bonus', style: 'success' },
      ]);
      rows.push([{ text: '📜 My Gmails' }, { text: '📜 History' }, { text: '🆘 Support' }]);
    } else if (isStar) {
      rows.push([
        { text: '⭐ My Stars', style: 'primary' },
        { text: '👥 Refer & Earn', style: 'primary' },
      ]);
      rows.push([
        { text: '🌟 Withdraw Stars', style: 'success' },
        { text: '👤 Set Username', style: 'primary' },
      ]);
      rows.push([{ text: '📜 Star History' }, { text: '🎁 Daily Stars', style: 'success' }]);
    } else if (isRedeem) {
      rows.push([
        { text: '💰 Balance', style: 'primary' },
        { text: '👥 Refer & Earn', style: 'primary' },
      ]);
      rows.push([
        { text: '🎁 Redeem Code', style: 'success' },
        { text: '📜 My Codes', style: 'primary' },
      ]);
      rows.push([{ text: '🎁 Daily Bonus', style: 'success' }, { text: '🆘 Support' }]);
    } else {
      rows.push([
        { text: '💰 Balance', style: 'primary' },
        { text: '👥 Refer & Earn', style: 'primary' },
      ]);
      rows.push([
        { text: '💸 Withdraw', style: 'success' },
        { text: '🏦 Set UPI ID', style: 'primary' },
      ]);
      rows.push([{ text: '📜 History' }, { text: '🎁 Daily Bonus', style: 'success' }]);
    }

    if (isAdvanced) {
      rows.push([
        { text: '📋 Tasks', style: 'primary' },
        { text: '🎫 Gift Code', style: 'success' },
      ]);
      rows.push([
        { text: '🏆 Leaderboard', style: 'primary' },
        ...(isRedeem ? [] : [{ text: '🆘 Support' }]),
      ]);
    } else if (!isRedeem && !isGmail) {
      rows.push([{ text: '🆘 Support' }]);
    }

    if (this.isChildAdmin(bot, userId)) {
      rows.push([{ text: '👑 Admin Panel', style: 'danger' }]);
    }
    return { keyboard: rows, resize_keyboard: true, is_persistent: true };
  }

  private async creditChildReferralIfEligible(bot: BotRow, userId: number): Promise<void> {
    const reward = Number(bot.per_refer);
    const res = withTx(this.db, () => {
      const u = this.db
        .prepare('SELECT referred_by, ref_credited, first_name, device_verified FROM child_users WHERE bot_db_id = ? AND user_id = ?')
        .get(bot.id, userId) as { referred_by: number; ref_credited: number; first_name: string; device_verified: number } | undefined;
      if (!u || u.referred_by <= 0 || u.ref_credited === 1) return null;
      if (bot.device_verify === 1 && u.device_verified === 0) return null;
      const upd = this.db
        .prepare('UPDATE child_users SET ref_credited = 1 WHERE bot_db_id = ? AND user_id = ? AND ref_credited = 0')
        .run(bot.id, userId);
      if (upd.changes > 0 && reward > 0) {
        this.db
          .prepare(
            'UPDATE child_users SET balance = balance + ?, total_earned = total_earned + ?, total_refs = total_refs + 1 WHERE bot_db_id = ? AND user_id = ?'
          )
          .run(reward, reward, bot.id, u.referred_by);
        return u;
      }
      return null;
    });

    if (res && reward > 0) {
      await sendMsg(
        bot.token,
        res.referred_by,
        `🎉 <b>New Verified Referral!</b>\n\n👤 User: <b>${esc(res.first_name)}</b>\n💵 Earned: <b>+${esc(fmtAmount(bot.currency, reward))}</b>`
      );
    }
  }

  private async handleChildUpdate(bot: BotRow, update: Record<string, unknown>): Promise<void> {
    const token = bot.token;
    const botDbId = bot.id;
    const curr = bot.currency;

    const msg = update.message as
      | {
          chat: { id: number };
          from: { id: number; username?: string; first_name?: string };
          text?: string;
          caption?: string;
          photo?: Array<{ file_id: string }>;
        }
      | undefined;
    const cb = update.callback_query as
      | {
          id: string;
          from: { id: number; username?: string; first_name?: string };
          message?: { chat: { id: number }; message_id: number };
          data?: string;
        }
      | undefined;

    if (!msg && !cb) return;
    const from = cb ? cb.from : msg!.from;
    const chatId = cb ? cb.message?.chat.id ?? 0 : msg!.chat.id;
    if (chatId <= 0) return;

    const userId = from.id;
    const username = from.username || '';
    const firstName = from.first_name || 'User';
    const text = (msg?.text || msg?.caption || '').trim();
    const photoFileId = msg?.photo && msg.photo.length > 0 ? msg.photo[msg.photo.length - 1].file_id : '';
    const data = (cb?.data || '').trim();
    const now = Math.floor(Date.now() / 1000);
    const isAdmin = this.isChildAdmin(bot, userId);

    if (bot.is_active === 0) {
      if (cb) await answerCb(token, cb.id, 'This bot is currently paused.', true);
      else await sendMsg(token, chatId, '⏸ <b>Bot Paused</b>\nThis bot is currently paused by the administrator.');
      return;
    }

    let refCandidate = 0;
    if (msg) {
      const m = text.match(/^\/start(?:\s+(\d+))?/);
      if (m?.[1]) {
        const cand = Number(m[1]);
        if (cand > 0 && cand !== userId) {
          const exists = this.db.prepare('SELECT user_id FROM child_users WHERE bot_db_id = ? AND user_id = ?').get(botDbId, cand);
          if (exists) refCandidate = cand;
        }
      }
    }

    const isStarBot = isStarBotType(bot.bot_type);
    const autoStarTarget = isStarBot && username ? `@${username}` : '';

    let user = this.db
      .prepare('SELECT * FROM child_users WHERE bot_db_id = ? AND user_id = ?')
      .get(botDbId, userId) as unknown as ChildUserRow | undefined;
    if (!user) {
      this.db
        .prepare(
          'INSERT INTO child_users (bot_db_id, user_id, username, first_name, upi_id, referred_by, joined_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(botDbId, userId, username, firstName, autoStarTarget, refCandidate, now, now);
      user = this.db
        .prepare('SELECT * FROM child_users WHERE bot_db_id = ? AND user_id = ?')
        .get(botDbId, userId) as unknown as ChildUserRow;
    } else {
      if (isStarBot && !user.upi_id && autoStarTarget) {
        this.db
          .prepare('UPDATE child_users SET username = ?, first_name = ?, upi_id = ?, last_active_at = ? WHERE id = ?')
          .run(username, firstName, autoStarTarget, now, user.id);
        user.upi_id = autoStarTarget;
      } else {
        this.db
          .prepare('UPDATE child_users SET username = ?, first_name = ?, last_active_at = ? WHERE id = ?')
          .run(username, firstName, now, user.id);
      }
      user.username = username;
      user.first_name = firstName;
    }

    if (user.is_banned === 1 && !isAdmin) {
      if (cb) await answerCb(token, cb.id, 'Your account is banned.', true);
      else await sendMsg(token, chatId, '🚫 <b>Access Denied</b>\nYou are banned from using this bot.');
      return;
    }

    if (bot.maintenance === 1 && !isAdmin) {
      if (cb) await answerCb(token, cb.id, 'Bot is under maintenance.', true);
      else await sendMsg(token, chatId, '🛠 <b>Maintenance Mode</b>\nPlease try again shortly.');
      return;
    }

    // 1. Force Join Check (Unlimited channels)
    if (!isAdmin) {
      const channels = this.db
        .prepare('SELECT * FROM child_channels WHERE bot_db_id = ? ORDER BY id ASC')
        .all(botDbId) as unknown as ChannelRow[];
      if (channels.length > 0) {
        const unjoined = await checkForceJoin(token, channels, userId);
        if (unjoined.length > 0) {
          if (cb && data === 'c_verify_join') {
            await answerCb(token, cb.id, 'Please join all required channels first!', true);
            return;
          }
          if (cb) await answerCb(token, cb.id);
          await sendMsg(
            token,
            chatId,
            `📢 <b>Join Required Channels (${unjoined.length} remaining)</b>\n\nJoin all channels below and tap <b>✅ I Joined / Verify</b>.`,
            buildForceJoinMarkup(unjoined, 'c_verify_join')
          );
          return;
        }
      }
    }

    if (cb && data === 'c_verify_join') {
      await answerCb(token, cb.id, 'Channels verified!');
      if (cb.message) {
        await tgApi(token, 'deleteMessage', { chat_id: chatId, message_id: cb.message.message_id });
      }
    }

    // 2. Device Verification Check (Child Bot)
    if (bot.device_verify === 1 && !isAdmin && user.device_verified === 0) {
      if (cb && data === 'c_check_dev') {
        await answerCb(token, cb.id, 'Device not verified yet. Tap Verify My Device first!', true);
        return;
      }
      const verifyUrl = this.createDeviceVerifyLink('child', botDbId, userId);
      if (verifyUrl && verifyUrl.startsWith('https://')) {
        if (cb) await answerCb(token, cb.id);
        await sendMsg(
          token,
          chatId,
          '📱 <b>Device Verification Required</b>\n\n<blockquote>🛡 Verify your device once to unlock earning, redeem codes &amp; UPI withdrawals:</blockquote>',
          {
            inline_keyboard: [
              [{ text: '📱 Verify My Device', url: verifyUrl, style: 'primary' }],
              [{ text: '🔄 I Verified', callback_data: 'c_check_dev', style: 'success' }],
            ],
          }
        );
        return;
      }
    }

    if (user.referred_by > 0 && user.ref_credited === 0) {
      await this.creditChildReferralIfEligible(bot, userId);
    }

    if (cb && data === 'c_verify_join') {
      await this.sendChildHome(bot, user, chatId);
      return;
    }

    if (text === '❌ Cancel' || text === '/cancel') {
      this.db.prepare("UPDATE child_users SET state = '', state_data = '' WHERE id = ?").run(user.id);
      await this.sendChildHome(bot, user, chatId, 'Cancelled.');
      return;
    }

    if (cb) {
      await this.handleChildCallback(bot, user, cb);
      return;
    }

    if ((text === '/admin' || text === '👑 Admin Panel') && isAdmin) {
      this.db.prepare("UPDATE child_users SET state = '', state_data = '' WHERE id = ?").run(user.id);
      await this.sendChildAdminMenu(bot, chatId);
      return;
    }

    const menuCmds = [
      '/start',
      '/balance',
      '/stars',
      '/refer',
      '/withdraw',
      '/upi',
      '/daily',
      '/history',
      '/redeem',
      '/tasks',
      '/gift',
      '/leaderboard',
      '/buy',
      '/sell',
      '/deposit',
      '/mygmails',
      '💰 Balance',
      '⭐ My Stars',
      '👥 Refer & Earn',
      '💸 Withdraw',
      '🌟 Withdraw Stars',
      '🏦 Set UPI ID',
      '👤 Set Username',
      '🎁 Daily Bonus',
      '🎁 Daily Stars',
      '📜 History',
      '📜 Star History',
      '🎁 Redeem Code',
      '📜 My Codes',
      '📋 Tasks',
      '🎫 Gift Code',
      '🏆 Leaderboard',
      '🛒 Buy Gmail',
      '📤 Sell Gmail',
      '💳 Deposit',
      '📜 My Gmails',
      '🆘 Support',
    ];
    const isMenuCmd = menuCmds.includes(text) || text.startsWith('/start ');

    if (isMenuCmd) {
      if (user.state !== '') {
        this.db.prepare("UPDATE child_users SET state = '', state_data = '' WHERE id = ?").run(user.id);
        user.state = '';
        user.state_data = '';
      }
    } else if (user.state !== '') {
      await this.handleChildState(bot, user, chatId, text, photoFileId);
      return;
    }

    const isRedeem = isRedeemBotType(bot.bot_type);
    const isStar = isStarBotType(bot.bot_type);
    const isGmail = isGmailBotType(bot.bot_type);
    const isAdv = isAdvancedBotType(bot.bot_type);

    if (text === '/start' || text.startsWith('/start ')) {
      await this.sendChildHome(bot, user, chatId);
    } else if (text === '💰 Balance' || text === '⭐ My Stars' || text === '/balance' || text === '/stars') {
      const targetShow = user.upi_id ? `<code>${esc(user.upi_id)}</code>` : '<i>Not Set</i>';
      const txt = isStar
        ? `⭐ <b>Your Star Wallet</b>\n\n` +
          `<blockquote>` +
          `🌟 <b>Stars Balance:</b> <code>${esc(fmtAmount(curr, user.balance))}</code>\n` +
          `📈 <b>Total Earned:</b> <code>${esc(fmtAmount(curr, user.total_earned))}</code>\n` +
          `✅ <b>Stars Withdrawn:</b> <code>${esc(fmtAmount(curr, user.total_withdrawn))}</code>\n` +
          `👥 <b>Referrals:</b> <code>${user.total_refs}</code>\n` +
          `👤 <b>Target Username:</b> ${targetShow}` +
          `</blockquote>`
        : `💰 <b>Your Wallet</b>\n\n` +
          `<blockquote>` +
          `💵 <b>Balance:</b> <code>${esc(fmtAmount(curr, user.balance))}</code>\n` +
          `📈 <b>Total Earned:</b> <code>${esc(fmtAmount(curr, user.total_earned))}</code>\n` +
          `✅ <b>Total ${isRedeem ? 'Redeemed' : 'Withdrawn'}:</b> <code>${esc(fmtAmount(curr, user.total_withdrawn))}</code>\n` +
          `👥 <b>Referrals:</b> <code>${user.total_refs}</code>` +
          (!isRedeem ? `\n🏦 <b>UPI ID:</b> ${targetShow}` : '') +
          `</blockquote>`;
      await sendMsg(token, chatId, txt, this.childMainKeyboard(bot, userId));
    } else if (text === '👥 Refer & Earn' || text === '/refer') {
      const link = `https://t.me/${bot.bot_username}?start=${userId}`;
      const txt =
        `👥 <b>Refer &amp; Earn</b>\n\n` +
        `Invite friends and earn <b>${esc(fmtAmount(curr, bot.per_refer))}</b> per verified referral!\n\n` +
        `<blockquote>🔗 <b>Your Referral Link:</b>\n<code>${link}</code>\n\n` +
        `📊 <b>Total Referrals:</b> <code>${user.total_refs}</code></blockquote>`;
      await sendMsg(token, chatId, txt, {
        inline_keyboard: [
          [
            {
              text: '📤 Share Referral Link',
              url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(isStar ? 'Join & earn free Telegram Stars!' : 'Join & earn rewards!')}`,
              style: 'success',
            },
          ],
        ],
      });
    } else if (text === '🎁 Daily Bonus' || text === '🎁 Daily Stars' || text === '/daily') {
      await this.handleChildDailyBonus(bot, user, chatId);
    } else if (isStar && text === '👤 Set Username') {
      this.db.prepare("UPDATE child_users SET state = 'c_await_star_user' WHERE id = ?").run(user.id);
      await sendMsg(
        token,
        chatId,
        `👤 <b>Set Receiver Username for Stars</b>\n\nCurrent: ${user.upi_id ? `<code>${esc(user.upi_id)}</code>` : '<i>None</i>'}\n\n` +
          `Send your Telegram <b>@username</b> (e.g. <code>@yourname</code>)\n` +
          `Or send <code>id</code> to use your User ID (<code>ID:${userId}</code>):`,
        { keyboard: [[{ text: '❌ Cancel', style: 'danger' }]], resize_keyboard: true }
      );
    } else if (!isRedeem && !isStar && (text === '🏦 Set UPI ID' || text === '/upi')) {
      this.db.prepare("UPDATE child_users SET state = 'c_await_upi' WHERE id = ?").run(user.id);
      await sendMsg(
        token,
        chatId,
        `🏦 <b>Set Your UPI ID</b>\n\nCurrent UPI: ${user.upi_id ? `<code>${esc(user.upi_id)}</code>` : '<i>None</i>'}\n\nSend valid UPI ID (e.g. <code>name@okicici</code>):`,
        { keyboard: [[{ text: '❌ Cancel', style: 'danger' }]], resize_keyboard: true }
      );
    } else if (!isRedeem && (text === '💸 Withdraw' || text === '🌟 Withdraw Stars' || text === '/withdraw')) {
      await this.handleChildWithdrawStart(bot, user, chatId);
    } else if (!isRedeem && (text === '📜 History' || text === '📜 Star History' || text === '/history')) {
      const wds = this.db
        .prepare('SELECT * FROM withdrawals WHERE bot_db_id = ? AND user_id = ? ORDER BY id DESC LIMIT 10')
        .all(botDbId, userId) as unknown as WithdrawalRow[];
      if (wds.length === 0) {
        await sendMsg(
          token,
          chatId,
          `📜 <b>${isStar ? 'Star Withdrawal History' : 'Withdrawal History'}</b>\n\nNo withdrawals yet.`,
          this.childMainKeyboard(bot, userId)
        );
        return;
      }
      const lines = [`📜 <b>${isStar ? 'Recent Star Withdrawals' : 'Recent Withdrawals'}</b>\n`];
      for (const w of wds) {
        const icon = w.status === 'paid' ? (isStar ? '✅ Sent' : '✅ Paid') : w.status === 'rejected' ? '❌ Rejected (Refunded)' : '⏳ Pending';
        lines.push(
          `#${w.id} · <b>${esc(fmtAmount(curr, w.amount))}</b> · ${icon}\n   ${isStar ? '👤' : '🏦'} <code>${esc(w.upi_id)}</code>`
        );
      }
      await sendMsg(token, chatId, lines.join('\n'), this.childMainKeyboard(bot, userId));
    } else if (isRedeem && (text === '🎁 Redeem Code' || text === '/redeem')) {
      await this.handleRedeemPlansUserView(bot, user, chatId);
    } else if (isRedeem && text === '📜 My Codes') {
      const codes = this.db
        .prepare(
          `SELECT rc.code, rc.used_at, rp.title, rp.cost
           FROM redeem_codes rc JOIN redeem_plans rp ON rp.id = rc.plan_id
           WHERE rc.bot_db_id = ? AND rc.used_by = ? ORDER BY rc.used_at DESC LIMIT 10`
        )
        .all(botDbId, userId) as unknown as Array<{ code: string; used_at: number; title: string; cost: number }>;
      if (codes.length === 0) {
        await sendMsg(token, chatId, '📜 <b>My Redeemed Codes</b>\n\nYou have not redeemed any codes yet.', this.childMainKeyboard(bot, userId));
        return;
      }
      const lines = ['📜 <b>Your Redeemed Codes</b>\n'];
      for (const c of codes) {
        lines.push(`🎟 <b>${esc(c.title)}</b> (${esc(fmtAmount(curr, c.cost))})\n   Code: <code>${esc(c.code)}</code>`);
      }
      await sendMsg(token, chatId, lines.join('\n'), this.childMainKeyboard(bot, userId));
    } else if (isAdv && (text === '📋 Tasks' || text === '/tasks')) {
      await this.handleChildTasksView(bot, user, chatId);
    } else if (isAdv && (text === '🎫 Gift Code' || text === '/gift')) {
      this.db.prepare("UPDATE child_users SET state = 'c_await_promo' WHERE id = ?").run(user.id);
      await sendMsg(token, chatId, '🎫 Send your <b>Gift / Promo Code</b> (or /cancel):', {
        keyboard: [[{ text: '❌ Cancel', style: 'danger' }]],
        resize_keyboard: true,
      });
    } else if (isAdv && (text === '🏆 Leaderboard' || text === '/leaderboard')) {
      const top = this.db
        .prepare('SELECT first_name, username, total_refs, total_earned FROM child_users WHERE bot_db_id = ? ORDER BY total_refs DESC, total_earned DESC LIMIT 10')
        .all(botDbId) as unknown as Array<{ first_name: string; username: string; total_refs: number; total_earned: number }>;
      const lines = ['🏆 <b>Top Referrers Leaderboard</b>\n'];
      top.forEach((r, idx) => {
        const name = r.username ? `@${esc(r.username)}` : esc(r.first_name);
        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
        lines.push(`${medal} <b>${name}</b> — <code>${r.total_refs}</code> refs (<code>${esc(fmtAmount(curr, r.total_earned))}</code>)`);
      });
      await sendMsg(token, chatId, lines.join('\n'), this.childMainKeyboard(bot, userId));
    } else if (isGmail && (text === '🛒 Buy Gmail' || text === '/buy')) {
      await this.handleGmailPlansUserView(bot, user, chatId);
    } else if (isGmail && (text === '📤 Sell Gmail' || text === '/sell')) {
      await this.handleGmailSellStart(bot, user, chatId);
    } else if (isGmail && (text === '💳 Deposit' || text === '/deposit')) {
      await this.handleChildDepositView(bot, chatId);
    } else if (isGmail && (text === '📜 My Gmails' || text === '/mygmails')) {
      const bought = this.db
        .prepare(
          `SELECT gs.account_data, gs.sold_at, gp.title, gp.price
           FROM gmail_stock gs JOIN gmail_plans gp ON gp.id = gs.plan_id
           WHERE gs.bot_db_id = ? AND gs.sold_to = ? ORDER BY gs.sold_at DESC LIMIT 10`
        )
        .all(botDbId, userId) as unknown as Array<{ account_data: string; sold_at: number; title: string; price: number }>;
      const soldReqs = this.db
        .prepare('SELECT id, account_data, price, status FROM gmail_sell_requests WHERE bot_db_id = ? AND user_id = ? ORDER BY id DESC LIMIT 5')
        .all(botDbId, userId) as unknown as Array<{ id: number; account_data: string; price: number; status: string }>;

      if (bought.length === 0 && soldReqs.length === 0) {
        await sendMsg(
          token,
          chatId,
          '📜 <b>My Gmails</b>\n\nYou have not bought or sold any Gmail accounts yet.',
          this.childMainKeyboard(bot, userId)
        );
        return;
      }
      const lines: string[] = [];
      if (bought.length > 0) {
        lines.push('🛒 <b>Purchased Gmails</b>');
        for (const b of bought) {
          lines.push(`📧 <b>${esc(b.title)}</b> (${esc(fmtAmount(curr, b.price))})\n   <code>${esc(b.account_data)}</code>`);
        }
      }
      if (soldReqs.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push('📤 <b>Your Gmail Sell Submissions</b>');
        for (const s of soldReqs) {
          const st = s.status === 'approved' ? '✅ Paid' : s.status === 'rejected' ? '❌ Rejected' : '⏳ Pending';
          lines.push(`#${s.id} · ${st} (${esc(fmtAmount(curr, s.price))})\n   <code>${esc(s.account_data.split(/[\s|:]/)[0] || s.account_data)}</code>`);
        }
      }
      await sendMsg(token, chatId, lines.join('\n'), this.childMainKeyboard(bot, userId));
    } else if (text === '🆘 Support') {
      const sup = bot.support_username || 'Bot Owner';
      await sendMsg(token, chatId, `🆘 <b>Support</b>\n\nContact: ${esc(sup)}`, this.childMainKeyboard(bot, userId));
    } else {
      await this.sendChildHome(bot, user, chatId);
    }
  }

  private async sendChildHome(bot: BotRow, user: ChildUserRow, chatId: number, prefix = ''): Promise<void> {
    const curr = bot.currency;
    const isRedeem = isRedeemBotType(bot.bot_type);
    const isStar = isStarBotType(bot.bot_type);
    const isGmail = isGmailBotType(bot.bot_type);
    const stockTotal = isGmail
      ? Number(
          (this.db.prepare('SELECT COUNT(*) AS c FROM gmail_stock WHERE bot_db_id = ? AND is_sold = 0').get(bot.id) as { c: number }).c
        )
      : 0;
    const msg =
      (prefix ? `✨ <i>${esc(prefix)}</i>\n\n` : '') +
      `🌈 <b>Welcome to ${esc(bot.bot_name)}!</b>\n` +
      `<i>${botTypeLabel(bot.bot_type)}</i>\n\n` +
      `<blockquote>` +
      `${isStar ? '⭐' : '💵'} <b>Your ${isStar ? 'Stars' : 'Balance'}:</b> <code>${esc(fmtAmount(curr, user.balance))}</code>\n` +
      (isGmail
        ? `📦 <b>Gmail Stock Available:</b> <code>${stockTotal}</code>\n` +
          `📤 <b>Sell Gmail Rate:</b> <code>${esc(fmtAmount(curr, bot.gmail_sell_price))}/Gmail</code>\n`
        : '') +
      `🎁 <b>Daily Bonus:</b> <code>${esc(fmtAmount(curr, bot.daily_bonus))}</code>\n` +
      `👥 <b>Per Refer:</b> <code>${esc(fmtAmount(curr, bot.per_refer))}</code>` +
      (!isRedeem ? `\n${isStar ? '🌟' : '🏦'} <b>Min Withdraw:</b> <code>${esc(fmtAmount(curr, bot.min_withdraw))}</code>` : '') +
      `</blockquote>\n\n` +
      (isGmail
        ? '📧 Buy fresh Gmails, sell your Gmails for instant wallet cash, deposit via QR, refer friends &amp; withdraw to UPI!'
        : isRedeem
          ? '🔥 Earn balance by referring friends &amp; claim instant <b>Gift / Play Redeem Codes</b>!'
          : isStar
            ? '⭐ Claim daily stars, invite friends &amp; withdraw <b>Telegram Stars</b> to your @username!'
            : '🔥 Invite friends &amp; withdraw earnings directly to your <b>UPI ID</b>!');
    await sendMsg(bot.token, chatId, msg, this.childMainKeyboard(bot, user.user_id));
  }

  private async handleGmailPlansUserView(bot: BotRow, user: ChildUserRow, chatId: number): Promise<void> {
    const plans = this.db
      .prepare(
        `SELECT gp.*, (SELECT COUNT(*) FROM gmail_stock gs WHERE gs.plan_id = gp.id AND gs.is_sold = 0) AS stock_count
         FROM gmail_plans gp WHERE gp.bot_db_id = ? AND gp.is_active = 1 ORDER BY gp.price ASC`
      )
      .all(bot.id) as unknown as GmailPlanRow[];
    if (plans.length === 0) {
      await sendMsg(
        bot.token,
        chatId,
        '🛒 <b>Buy Gmail Store</b>\n\nNo Gmail stock plans added by admin yet.',
        this.childMainKeyboard(bot, user.user_id)
      );
      return;
    }
    const rows = plans.map((p) => {
      const stk = p.stock_count ?? 0;
      return [
        {
          text: `📧 ${p.title} — ${bot.currency}${fmtNum(p.price)} · Stock: ${stk}`,
          callback_data: `c_gbuy:${p.id}`,
          style: (stk > 0 ? 'success' : 'danger') as TgButtonStyle,
        },
      ];
    });
    await sendMsg(
      bot.token,
      chatId,
      `🛒 <b>Buy Gmail Store</b>\n\n<blockquote>💵 Your Balance: <code>${esc(fmtAmount(bot.currency, user.balance))}</code></blockquote>\nSelect a Gmail plan to buy instantly:`,
      { inline_keyboard: rows }
    );
  }

  private async handleGmailSellStart(bot: BotRow, user: ChildUserRow, chatId: number): Promise<void> {
    const kb = this.childMainKeyboard(bot, user.user_id);
    if (bot.gmail_sell_open === 0) {
      await sendMsg(bot.token, chatId, '📤 Gmail selling is temporarily paused by the bot admin.', kb);
      return;
    }
    this.db.prepare("UPDATE child_users SET state = 'c_await_gsell' WHERE id = ?").run(user.id);
    await sendMsg(
      bot.token,
      chatId,
      `📤 <b>Sell Gmail &amp; Earn Cash</b>\n\n` +
        `<blockquote>💵 <b>Buy-Back Rate:</b> <code>${esc(fmtAmount(bot.currency, bot.gmail_sell_price))} per Gmail</code></blockquote>\n\n` +
        `Send your Gmail account details below (one per line for multiple):\n` +
        `<code>example@gmail.com | Password123</code>\n` +
        `<i>(Optional recovery email: <code>email | pass | recovery@mail.com</code>)</i>`,
      { keyboard: [[{ text: '❌ Cancel', style: 'danger' }]], resize_keyboard: true }
    );
  }

  private async handleChildDepositView(bot: BotRow, chatId: number): Promise<void> {
    if (bot.deposit_enabled === 0) {
      await sendMsg(bot.token, chatId, '💳 Deposits are temporarily closed by the bot admin.');
      return;
    }
    const caption =
      `💳 <b>Add Balance (Deposit via QR / UPI)</b>\n\n` +
      `<blockquote>` +
      `📉 <b>Minimum Deposit:</b> <code>${esc(fmtAmount(bot.currency, bot.min_deposit))}</code>` +
      (bot.deposit_upi_id ? `\n🏦 <b>Pay UPI ID:</b> <code>${esc(bot.deposit_upi_id)}</code>` : '') +
      `</blockquote>\n\n` +
      `Pay via QR / UPI above, then tap <b>📥 I Have Paid</b> and submit your Amount &amp; UTR / Payment Screenshot.`;
    const kb = {
      inline_keyboard: [[{ text: '📥 I Have Paid (Submit Deposit)', callback_data: 'c_dep_start', style: 'success' as TgButtonStyle }]],
    };
    if (bot.deposit_qr_file_id) {
      await sendPhotoMsg(bot.token, chatId, bot.deposit_qr_file_id, caption, kb);
    } else {
      await sendMsg(bot.token, chatId, caption, kb);
    }
  }

  private async handleRedeemPlansUserView(bot: BotRow, user: ChildUserRow, chatId: number): Promise<void> {
    const plans = this.db
      .prepare(
        `SELECT rp.*, (SELECT COUNT(*) FROM redeem_codes rc WHERE rc.plan_id = rp.id AND rc.is_used = 0) AS stock_count
         FROM redeem_plans rp WHERE rp.bot_db_id = ? AND rp.is_active = 1 ORDER BY rp.cost ASC`
      )
      .all(bot.id) as unknown as RedeemPlanRow[];
    if (plans.length === 0) {
      await sendMsg(bot.token, chatId, '🎁 <b>Redeem Store</b>\n\nNo redeem plans added by admin yet.', this.childMainKeyboard(bot, user.user_id));
      return;
    }
    const isAdv = bot.bot_type === 'redeem_advanced';
    const rows = plans.map((p) => {
      const hasStock = (p.stock_count ?? 0) > 0;
      const stockTag = isAdv ? ` · Stock: ${p.stock_count ?? 0}` : hasStock ? '' : ' (Out)';
      return [
        {
          text: `🎟 ${p.title} — ${bot.currency}${fmtNum(p.cost)}${stockTag}`,
          callback_data: `c_redeem:${p.id}`,
          style: (hasStock ? 'success' : 'danger') as TgButtonStyle,
        },
      ];
    });
    await sendMsg(
      bot.token,
      chatId,
      `🎁 <b>Redeem Code Store</b>\n\n<blockquote>💵 Your Balance: <code>${esc(bot.currency)}${fmtNum(user.balance)}</code></blockquote>\nChoose a plan to redeem:`,
      { inline_keyboard: rows }
    );
  }

  private async handleChildTasksView(bot: BotRow, user: ChildUserRow, chatId: number): Promise<void> {
    const tasks = this.db
      .prepare('SELECT * FROM child_tasks WHERE bot_db_id = ? AND is_active = 1 ORDER BY id DESC')
      .all(bot.id) as unknown as ChildTaskRow[];
    if (tasks.length === 0) {
      await sendMsg(bot.token, chatId, '📋 <b>Tasks</b>\n\nNo active tasks right now.', this.childMainKeyboard(bot, user.user_id));
      return;
    }
    const claimedIds = new Set(
      (
        this.db
          .prepare('SELECT task_id FROM child_task_claims WHERE bot_db_id = ? AND user_id = ?')
          .all(bot.id, user.user_id) as unknown as Array<{ task_id: number }>
      ).map((r) => r.task_id)
    );
    const available = tasks.filter((t) => !claimedIds.has(t.id));
    if (available.length === 0) {
      await sendMsg(bot.token, chatId, '🎉 You have completed all available tasks!', this.childMainKeyboard(bot, user.user_id));
      return;
    }
    for (const t of available.slice(0, 6)) {
      await sendMsg(
        bot.token,
        chatId,
        `📋 <b>${esc(t.title)}</b>\n💵 Reward: <b>+${esc(fmtAmount(bot.currency, t.reward))}</b>`,
        {
          inline_keyboard: [
            [
              { text: '🔗 Open Task', url: t.url, style: 'primary' },
              { text: '✅ Claim Reward', callback_data: `c_task:${t.id}`, style: 'success' },
            ],
          ],
        }
      );
    }
  }

  private async handleChildDailyBonus(bot: BotRow, user: ChildUserRow, chatId: number): Promise<void> {
    const bonus = Number(bot.daily_bonus);
    const curr = bot.currency;
    const kb = this.childMainKeyboard(bot, user.user_id);
    if (bonus <= 0) {
      await sendMsg(bot.token, chatId, '🎁 Daily bonus is currently disabled in this bot.', kb);
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const res = withTx(this.db, () => {
      const row = this.db.prepare('SELECT balance, last_daily_at FROM child_users WHERE id = ?').get(user.id) as {
        balance: number;
        last_daily_at: number;
      };
      const diff = now - row.last_daily_at;
      if (diff < 86400) return { ok: false as const, wait: fmtDuration(86400 - diff) };
      this.db
        .prepare('UPDATE child_users SET balance = balance + ?, total_earned = total_earned + ?, last_daily_at = ? WHERE id = ?')
        .run(bonus, bonus, now, user.id);
      return { ok: true as const, newBal: row.balance + bonus };
    });

    if (!res.ok) {
      await sendMsg(bot.token, chatId, `⏳ Daily bonus already claimed! Next claim in <b>${res.wait}</b>.`, kb);
      return;
    }
    await sendMsg(
      bot.token,
      chatId,
      `🎉 <b>Daily Bonus Claimed!</b>\n\n<blockquote>➕ Added: <b>+${esc(fmtAmount(curr, bonus))}</b>\n${isStarBotType(bot.bot_type) ? '⭐' : '💵'} Balance: <b>${esc(fmtAmount(curr, res.newBal))}</b></blockquote>`,
      kb
    );
  }

  private async handleChildWithdrawStart(bot: BotRow, user: ChildUserRow, chatId: number): Promise<void> {
    const token = bot.token;
    const curr = bot.currency;
    const kb = this.childMainKeyboard(bot, user.user_id);
    const isStar = isStarBotType(bot.bot_type);
    const isStarAdv = bot.bot_type === 'star_advanced';

    if (bot.withdrawals_open === 0) {
      await sendMsg(token, chatId, '⏸ Withdrawals are temporarily closed by the bot admin.', kb);
      return;
    }
    if (!user.upi_id) {
      await sendMsg(
        token,
        chatId,
        isStar
          ? '👤 Please set your Telegram <b>@username</b> first using <b>👤 Set Username</b>.'
          : '🏦 Please set your <b>UPI ID</b> first using <b>🏦 Set UPI ID</b>.',
        kb
      );
      return;
    }
    if (user.balance < bot.min_withdraw) {
      await sendMsg(
        token,
        chatId,
        `❌ <b>Minimum Withdraw Not Reached</b>\n\n<blockquote>${isStar ? '⭐' : '💵'} Your Balance: <code>${esc(fmtAmount(curr, user.balance))}</code>\n${isStar ? '🌟' : '🏦'} Minimum Withdraw: <code>${esc(fmtAmount(curr, bot.min_withdraw))}</code></blockquote>`,
        kb
      );
      return;
    }

    this.db.prepare("UPDATE child_users SET state = 'c_await_wd_amt' WHERE id = ?").run(user.id);

    const inlineRows: Array<Array<{ text: string; callback_data: string; style?: TgButtonStyle }>> = [];
    if (isStarAdv) {
      const packs = [
        { amt: 15, label: '🧸 15 ⭐ Gift' },
        { amt: 25, label: '🌹 25 ⭐ Gift' },
        { amt: 50, label: '🎁 50 ⭐ Gift' },
        { amt: 100, label: '💎 100 ⭐ Gift' },
      ].filter((p) => p.amt >= bot.min_withdraw && p.amt <= user.balance);
      if (packs.length > 0) {
        for (let i = 0; i < packs.length; i += 2) {
          const row = packs.slice(i, i + 2).map((p) => ({
            text: p.label,
            callback_data: `c_star_pack:${p.amt}`,
            style: 'primary' as TgButtonStyle,
          }));
          inlineRows.push(row);
        }
      }
    }
    inlineRows.push([
      { text: `💯 Withdraw Full (${fmtAmount(curr, user.balance)})`, callback_data: 'c_wd_full', style: 'success' },
    ]);

    await sendMsg(
      token,
      chatId,
      `${isStar ? '🌟 <b>Withdraw Telegram Stars</b>' : '💸 <b>Withdraw to UPI</b>'}\n\n` +
        `<blockquote>${isStar ? '👤 Receiver' : '🏦 UPI ID'}: <code>${esc(user.upi_id)}</code>\n` +
        `${isStar ? '⭐' : '💵'} Available: <code>${esc(fmtAmount(curr, user.balance))}</code>\n` +
        `📉 Minimum: <code>${esc(fmtAmount(curr, bot.min_withdraw))}</code></blockquote>\n\n` +
        (isStarAdv ? 'Select a Star Gift Pack, tap Withdraw Full, or enter custom Stars amount:' : 'Enter amount or tap below:'),
      { inline_keyboard: inlineRows }
    );
  }

  private async processChildWithdraw(
    bot: BotRow,
    user: ChildUserRow,
    chatId: number,
    rawAmount: number,
    note = ''
  ): Promise<void> {
    const token = bot.token;
    const curr = bot.currency;
    const kb = this.childMainKeyboard(bot, user.user_id);
    const isStar = isStarBotType(bot.bot_type);
    const amount = isStar ? Math.floor(rawAmount * 100) / 100 : Math.round(rawAmount * 100) / 100;

    if (amount < bot.min_withdraw) {
      await sendMsg(token, chatId, `❌ Minimum withdrawal is <b>${esc(fmtAmount(curr, bot.min_withdraw))}</b>.`);
      return;
    }

    const res = withTx(this.db, () => {
      const fresh = this.db.prepare('SELECT balance, upi_id FROM child_users WHERE id = ?').get(user.id) as {
        balance: number;
        upi_id: string;
      };
      if (amount > fresh.balance + 0.00001 || !fresh.upi_id) {
        this.db.prepare("UPDATE child_users SET state = '' WHERE id = ?").run(user.id);
        return { ok: false as const, bal: fresh.balance };
      }
      this.db.prepare("UPDATE child_users SET balance = ROUND(balance - ?, 2), state = '' WHERE id = ?").run(amount, user.id);
      const ins = this.db
        .prepare("INSERT INTO withdrawals (bot_db_id, user_id, amount, upi_id, status, note, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
        .run(bot.id, user.user_id, amount, fresh.upi_id, note, Math.floor(Date.now() / 1000));
      return { ok: true as const, wdId: Number(ins.lastInsertRowid), upiId: fresh.upi_id };
    });

    if (!res.ok) {
      await sendMsg(token, chatId, `❌ Insufficient balance (<code>${esc(fmtAmount(curr, res.bal))}</code>).`, kb);
      return;
    }

    await sendMsg(
      token,
      chatId,
      isStar
        ? `🌟 <b>Star Withdrawal Submitted!</b>\n\n<blockquote>🎫 Ticket: <code>#${res.wdId}</code>\n⭐ Stars: <b>${esc(fmtAmount(curr, amount))}</b>${note ? `\n🎁 Pack: <b>${esc(note)}</b>` : ''}\n👤 Username: <code>${esc(res.upiId)}</code>\n📌 Status: <b>⏳ Pending Star Delivery</b></blockquote>`
        : `✅ <b>Withdrawal Request Submitted!</b>\n\n🎫 Ticket: <code>#${res.wdId}</code>\n💵 Amount: <b>${esc(fmtAmount(curr, amount))}</b>\n🏦 UPI ID: <code>${esc(res.upiId)}</code>\n📌 Status: <b>⏳ Pending Approval</b>`,
      kb
    );

    const adminMsg = isStar
      ? `🌟 <b>New Star Withdrawal #${res.wdId}</b>\n\n<blockquote>👤 User: <b>${esc(user.first_name)}</b> (<code>${user.user_id}</code>)\n⭐ Stars: <b>${esc(fmtAmount(curr, amount))}</b>${note ? `\n🎁 Pack: <b>${esc(note)}</b>` : ''}\n🎯 Send To: <code>${esc(res.upiId)}</code></blockquote>`
      : `🔔 <b>New Withdrawal Request #${res.wdId}</b>\n\n👤 User: <b>${esc(user.first_name)}</b> (<code>${user.user_id}</code>)\n💵 Amount: <b>${esc(fmtAmount(curr, amount))}</b>\n🏦 UPI ID: <code>${esc(res.upiId)}</code>`;

    const wdRows: Array<Array<{ text: string; callback_data?: string; url?: string; style?: TgButtonStyle }>> = [
      [
        { text: isStar ? '✅ Approve (Stars Sent)' : '✅ Approve (Paid)', callback_data: `ca_wd_ok:${res.wdId}`, style: 'success' },
        { text: '❌ Reject (Refund)', callback_data: `ca_wd_no:${res.wdId}`, style: 'danger' },
      ],
    ];
    if (isStar && res.upiId.startsWith('@')) {
      wdRows.push([{ text: `👤 Open ${res.upiId}`, url: `https://t.me/${res.upiId.slice(1)}`, style: 'primary' }]);
    }
    const wdKb = { inline_keyboard: wdRows };

    const childAdmins = (
      this.db.prepare('SELECT user_id FROM child_admins WHERE bot_db_id = ?').all(bot.id) as unknown as Array<{ user_id: number }>
    ).map((r) => r.user_id);
    const notifyIds = Array.from(new Set([bot.owner_id, ...childAdmins]));
    for (const adm of notifyIds) {
      await sendMsg(token, adm, adminMsg, wdKb);
    }
  }

  private async handleChildState(
    bot: BotRow,
    user: ChildUserRow,
    chatId: number,
    text: string,
    photoFileId = ''
  ): Promise<void> {
    const token = bot.token;
    const state = user.state;
    let stateData: Record<string, unknown> = {};
    try {
      if (user.state_data) stateData = JSON.parse(user.state_data) as Record<string, unknown>;
    } catch {
      stateData = {};
    }

    if (state === 'c_await_gsell') {
      const lines = text
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length >= 6 && s.includes('@'));
      if (lines.length === 0) {
        await sendMsg(
          token,
          chatId,
          '❌ Invalid format. Send valid Gmail details like <code>example@gmail.com | Password123</code> (or /cancel):'
        );
        return;
      }
      const price = Number(bot.gmail_sell_price);
      const now = Math.floor(Date.now() / 1000);
      const insertedIds: number[] = [];
      const ins = this.db.prepare(
        "INSERT INTO gmail_sell_requests (bot_db_id, user_id, account_data, price, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)"
      );
      withTx(this.db, () => {
        for (const line of lines.slice(0, 15)) {
          const r = ins.run(bot.id, user.user_id, line.slice(0, 250), price, now);
          insertedIds.push(Number(r.lastInsertRowid));
        }
      });
      this.db.prepare("UPDATE child_users SET state = '' WHERE id = ?").run(user.id);
      const totalEst = Math.round(insertedIds.length * price * 100) / 100;
      await sendMsg(
        token,
        chatId,
        `✅ <b>${insertedIds.length} Gmail Submission(s) Received!</b>\n\n` +
          `<blockquote>💵 Expected Payout: <b>${esc(fmtAmount(bot.currency, totalEst))}</b>\n` +
          `📌 Status: <b>⏳ Pending Admin Verification</b></blockquote>`,
        this.childMainKeyboard(bot, user.user_id)
      );

      const childAdmins = (
        this.db.prepare('SELECT user_id FROM child_admins WHERE bot_db_id = ?').all(bot.id) as unknown as Array<{ user_id: number }>
      ).map((r) => r.user_id);
      const notifyIds = Array.from(new Set([bot.owner_id, ...childAdmins]));
      for (let i = 0; i < insertedIds.length; i++) {
        const sid = insertedIds[i];
        const acc = lines[i];
        const admTxt =
          `📤 <b>New Gmail Sell Request #${sid}</b>\n\n` +
          `<blockquote>👤 Seller: <b>${esc(user.first_name)}</b> (<code>${user.user_id}</code>)\n` +
          `💵 Payout: <b>${esc(fmtAmount(bot.currency, price))}</b>\n` +
          `📧 Account: <code>${esc(acc)}</code></blockquote>`;
        const admKb = {
          inline_keyboard: [
            [
              { text: `✅ Approve (+${fmtAmount(bot.currency, price)})`, callback_data: `ca_gsell_ok:${sid}`, style: 'success' as TgButtonStyle },
              { text: '❌ Reject', callback_data: `ca_gsell_no:${sid}`, style: 'danger' as TgButtonStyle },
            ],
            [{ text: '📦 Approve & Add to Stock', callback_data: `ca_gsell_stk:${sid}`, style: 'primary' as TgButtonStyle }],
          ],
        };
        for (const adm of notifyIds) {
          await sendMsg(token, adm, admTxt, admKb);
        }
      }
      return;
    }

    if (state === 'c_dep_amt') {
      const amt = Number(text);
      const minDep = Number(bot.min_deposit || 10);
      if (!Number.isFinite(amt) || amt < minDep) {
        await sendMsg(token, chatId, `❌ Minimum deposit is <b>${esc(fmtAmount(bot.currency, minDep))}</b>. Enter valid amount (or /cancel):`);
        return;
      }
      const cleanAmt = Math.round(amt * 100) / 100;
      this.db
        .prepare("UPDATE child_users SET state = 'c_dep_utr', state_data = ? WHERE id = ?")
        .run(JSON.stringify({ amt: cleanAmt }), user.id);
      await sendMsg(
        token,
        chatId,
        `💵 Deposit Amount: <b>${esc(fmtAmount(bot.currency, cleanAmt))}</b>\n\n` +
          `Now send your <b>12-digit UTR / Transaction ID</b> or a <b>Payment Screenshot Photo</b>:`
      );
      return;
    }

    if (state === 'c_dep_utr') {
      const amt = Number(stateData.amt || 0);
      const utr = text.trim() || (photoFileId ? 'Screenshot Attached' : '');
      if (!utr && !photoFileId) {
        await sendMsg(token, chatId, '❌ Send your UTR / Transaction ID or a payment screenshot.');
        return;
      }
      const ins = this.db
        .prepare(
          "INSERT INTO child_deposits (bot_db_id, user_id, amount, utr, screenshot_file_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
        )
        .run(bot.id, user.user_id, amt, utr.slice(0, 120), photoFileId, Math.floor(Date.now() / 1000));
      const depId = Number(ins.lastInsertRowid);
      this.db.prepare("UPDATE child_users SET state = '', state_data = '' WHERE id = ?").run(user.id);

      await sendMsg(
        token,
        chatId,
        `✅ <b>Deposit Request Submitted (#${depId})</b>\n\n` +
          `<blockquote>💵 Amount: <b>${esc(fmtAmount(bot.currency, amt))}</b>\n` +
          `🧾 UTR: <code>${esc(utr)}</code>\n` +
          `📌 Status: <b>⏳ Pending Admin Approval</b></blockquote>`,
        this.childMainKeyboard(bot, user.user_id)
      );

      const childAdmins = (
        this.db.prepare('SELECT user_id FROM child_admins WHERE bot_db_id = ?').all(bot.id) as unknown as Array<{ user_id: number }>
      ).map((r) => r.user_id);
      const notifyIds = Array.from(new Set([bot.owner_id, ...childAdmins]));
      const adminCaption =
        `💳 <b>New Bot Deposit #${depId}</b>\n\n` +
        `<blockquote>👤 User: <b>${esc(user.first_name)}</b> (<code>${user.user_id}</code>)\n` +
        `💵 Amount: <b>${esc(fmtAmount(bot.currency, amt))}</b>\n` +
        `🧾 UTR: <code>${esc(utr)}</code></blockquote>`;
      const admKb = {
        inline_keyboard: [
          [
            { text: `✅ Approve (+${fmtAmount(bot.currency, amt)})`, callback_data: `ca_dep_ok:${depId}`, style: 'success' as TgButtonStyle },
            { text: '❌ Reject', callback_data: `ca_dep_no:${depId}`, style: 'danger' as TgButtonStyle },
          ],
        ],
      };
      for (const adm of notifyIds) {
        if (photoFileId) await sendPhotoMsg(token, adm, photoFileId, adminCaption, admKb);
        else await sendMsg(token, adm, adminCaption, admKb);
      }
      return;
    }

    if (state === 'c_await_star_user') {
      const raw = text.trim();
      let target = '';
      if (raw.toLowerCase() === 'id') {
        target = `ID:${user.user_id}`;
      } else {
        const clean = raw.startsWith('@') ? raw : `@${raw}`;
        if (!/^@[a-zA-Z0-9_]{4,32}$/.test(clean)) {
          await sendMsg(
            token,
            chatId,
            '❌ Invalid Telegram username. Send <code>@username</code> (4-32 letters/numbers/_) or send <code>id</code>:'
          );
          return;
        }
        target = clean;
      }
      this.db.prepare("UPDATE child_users SET upi_id = ?, state = '' WHERE id = ?").run(target, user.id);
      await sendMsg(token, chatId, `✅ Star receiver saved: <code>${esc(target)}</code>`, this.childMainKeyboard(bot, user.user_id));
      return;
    }

    if (state === 'c_await_upi') {
      const upi = text.trim();
      if (!/^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/.test(upi)) {
        await sendMsg(token, chatId, '❌ Invalid UPI ID format. Example: <code>username@okaxis</code>');
        return;
      }
      this.db.prepare("UPDATE child_users SET upi_id = ?, state = '' WHERE id = ?").run(upi, user.id);
      await sendMsg(token, chatId, `✅ UPI ID saved: <code>${esc(upi)}</code>`, this.childMainKeyboard(bot, user.user_id));
      return;
    }

    if (state === 'c_await_wd_amt') {
      const num = Number(text);
      if (!Number.isFinite(num) || num <= 0) {
        await sendMsg(token, chatId, '❌ Please enter a valid numeric amount (or /cancel).');
        return;
      }
      await this.processChildWithdraw(bot, user, chatId, num);
      return;
    }

    if (state === 'c_await_promo') {
      const code = text.trim().toUpperCase();
      const res = withTx(this.db, () => {
        const promo = this.db
          .prepare('SELECT * FROM child_promos WHERE bot_db_id = ? AND UPPER(code) = ?')
          .get(bot.id, code) as unknown as ChildPromoRow | undefined;
        if (!promo) return { ok: false as const, msg: '❌ Invalid gift code.' };
        if (promo.used_count >= promo.max_uses) return { ok: false as const, msg: '❌ Gift code limit reached.' };
        const already = this.db
          .prepare('SELECT 1 FROM child_promo_claims WHERE bot_db_id = ? AND promo_id = ? AND user_id = ?')
          .get(bot.id, promo.id, user.user_id);
        if (already) return { ok: false as const, msg: '❌ You already claimed this gift code.' };

        this.db
          .prepare('INSERT INTO child_promo_claims (bot_db_id, promo_id, user_id, claimed_at) VALUES (?, ?, ?, ?)')
          .run(bot.id, promo.id, user.user_id, Math.floor(Date.now() / 1000));
        this.db.prepare('UPDATE child_promos SET used_count = used_count + 1 WHERE id = ?').run(promo.id);
        this.db
          .prepare('UPDATE child_users SET balance = balance + ?, total_earned = total_earned + ? WHERE id = ?')
          .run(promo.reward, promo.reward, user.id);
        return { ok: true as const, reward: promo.reward };
      });
      this.db.prepare("UPDATE child_users SET state = '' WHERE id = ?").run(user.id);
      await sendMsg(
        token,
        chatId,
        res.ok
          ? `🎉 <b>Gift Code Claimed!</b>\n\n💵 Added: <b>+${esc(fmtAmount(bot.currency, res.reward))}</b>`
          : res.msg,
        this.childMainKeyboard(bot, user.user_id)
      );
      return;
    }

    if (!this.isChildAdmin(bot, user.user_id)) {
      this.db.prepare("UPDATE child_users SET state = '' WHERE id = ?").run(user.id);
      await this.sendChildHome(bot, user, chatId);
      return;
    }

    // Child Admin States
    if (state === 'ca_dep_qr') {
      if (!photoFileId) {
        await sendMsg(token, chatId, '❌ Please send a <b>Deposit QR Code Image (Photo)</b>, not text (or /cancel).');
        return;
      }
      this.db.prepare('UPDATE bots SET deposit_qr_file_id = ? WHERE id = ?').run(photoFileId, bot.id);
      this.db.prepare("UPDATE child_users SET state = '' WHERE id = ?").run(user.id);
      const freshBot = this.db.prepare('SELECT * FROM bots WHERE id = ?').get(bot.id) as unknown as BotRow;
      await sendMsg(token, chatId, '✅ Bot Deposit QR Code uploaded!', this.childMainKeyboard(freshBot, user.user_id));
      await this.sendChildDepositAdminMenu(freshBot, chatId);
      return;
    }

    if (state === 'ca_dep_upi') {
      this.db.prepare('UPDATE bots SET deposit_upi_id = ? WHERE id = ?').run(text.trim(), bot.id);
      this.db.prepare("UPDATE child_users SET state = '' WHERE id = ?").run(user.id);
      const freshBot = this.db.prepare('SELECT * FROM bots WHERE id = ?').get(bot.id) as unknown as BotRow;
      await sendMsg(token, chatId, `✅ Deposit UPI ID saved: <code>${esc(text.trim())}</code>`);
      await this.sendChildDepositAdminMenu(freshBot, chatId);
      return;
    }

    if (state === 'ca_dep_min') {
      const num = Number(text);
      if (!Number.isFinite(num) || num < 1) {
        await sendMsg(token, chatId, '❌ Enter valid minimum deposit amount in ₹ (>= 1).');
        return;
      }
      this.db.prepare('UPDATE bots SET min_deposit = ? WHERE id = ?').run(Math.round(num * 100) / 100, bot.id);
      this.db.prepare("UPDATE child_users SET state = '' WHERE id = ?").run(user.id);
      const freshBot = this.db.prepare('SELECT * FROM bots WHERE id = ?').get(bot.id) as unknown as BotRow;
      await sendMsg(token, chatId, `✅ Minimum deposit updated to ${esc(fmtAmount(bot.currency, num))}.`);
      await this.sendChildDepositAdminMenu(freshBot, chatId);
      return;
    }

    if (state === 'ca_gplan_add') {
      if (!text.includes('|')) {
        await sendMsg(token, chatId, '❌ Format: <code>Plan Title | Price</code> (example: <code>Fresh Gmail | 15</code>)');
        return;
      }
      const [title, priceStr] = text.split('|', 2).map((s) => s.trim());
      const price = Number(priceStr);
      if (!title || !Number.isFinite(price) || price <= 0) {
        await sendMsg(token, chatId, '❌ Invalid plan title or price.');
        return;
      }
      this.db
        .prepare('INSERT INTO gmail_plans (bot_db_id, title, price, is_active, created_at) VALUES (?, ?, ?, 1, ?)')
        .run(bot.id, title, Math.round(price * 100) / 100, Math.floor(Date.now() / 1000));
      this.db.prepare("UPDATE child_users SET state = '' WHERE id = ?").run(user.id);
      await sendMsg(token, chatId, `✅ Gmail Plan added: <b>${esc(title)}</b> (${esc(fmtAmount(bot.currency, price))})`);
      await this.sendGmailPlansAdminMenu(bot, chatId);
      return;
    }

    if (state === 'ca_gplan_stock') {
      const planId = Number(stateData.plan_id || 0);
      const lines = text
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const now = Math.floor(Date.now() / 1000);
      const ins = this.db.prepare(
        'INSERT INTO gmail_stock (bot_db_id, plan_id, account_data, is_sold, created_at) VALUES (?, ?, ?, 0, ?)'
      );
      withTx(this.db, () => {
        for (const acc of lines) ins.run(bot.id, planId, acc, now);
      });
      this.db.prepare("UPDATE child_users SET state = '', state_data = '' WHERE id = ?").run(user.id);
      await sendMsg(token, chatId, `✅ Added <b>${lines.length}</b> Gmail account(s) to stock!`);
      await this.sendGmailPlansAdminMenu(bot, chatId);
      return;
    }

    // Child Admin States
    if (state === 'ca_admin_add') {
      if (!/^\d+$/.test(text.trim())) {
        await sendMsg(token, chatId, '❌ Send numeric Telegram User ID.');
        return;
      }
      const newAdmId = Number(text.trim());
      this.db
        .prepare('INSERT OR IGNORE INTO child_admins (bot_db_id, user_id, added_by, added_at) VALUES (?, ?, ?, ?)')
        .run(bot.id, newAdmId, user.user_id, Math.floor(Date.now() / 1000));
      this.db.prepare("UPDATE child_users SET state = '' WHERE id = ?").run(user.id);
      await sendMsg(token, newAdmId, `👑 You were added as Admin in <b>@${esc(bot.bot_username)}</b>! Send /admin to manage.`);
      await sendMsg(token, chatId, `✅ Added Bot Admin: <code>${newAdmId}</code>`);
      await this.sendChildAdminsMenu(bot, chatId);
      return;
    }

    if (state === 'ca_plan_add') {
      if (!text.includes('|')) {
        await sendMsg(token, chatId, '❌ Use format: <code>Plan Title | Cost</code> (e.g. <code>₹10 Play Code | 10</code>)');
        return;
      }
      const [title, costStr] = text.split('|', 2).map((s) => s.trim());
      const cost = Number(costStr);
      if (!title || !Number.isFinite(cost) || cost <= 0) {
        await sendMsg(token, chatId, '❌ Invalid title or cost.');
        return;
      }
      this.db
        .prepare('INSERT INTO redeem_plans (bot_db_id, title, cost, is_active, created_at) VALUES (?, ?, ?, 1, ?)')
        .run(bot.id, title, cost, Math.floor(Date.now() / 1000));
      this.db.prepare("UPDATE child_users SET state = '' WHERE id = ?").run(user.id);
      await sendMsg(token, chatId, `✅ Redeem plan added: <b>${esc(title)}</b> (${esc(bot.currency)}${fmtNum(cost)})`);
      await this.sendChildPlansMenu(bot, chatId);
      return;
    }

    if (state === 'ca_plan_codes') {
      const planId = Number(stateData.plan_id || 0);
      const codes = text
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const now = Math.floor(Date.now() / 1000);
      const ins = this.db.prepare(
        'INSERT INTO redeem_codes (bot_db_id, plan_id, code, is_used, created_at) VALUES (?, ?, ?, 0, ?)'
      );
      withTx(this.db, () => {
        for (const c of codes) ins.run(bot.id, planId, c, now);
      });
      this.db.prepare("UPDATE child_users SET state = '', state_data = '' WHERE id = ?").run(user.id);
      await sendMsg(token, chatId, `✅ Added <b>${codes.length}</b> redeem code(s) to stock!`);
      await this.sendChildPlansMenu(bot, chatId);
      return;
    }

    if (state === 'ca_task_add') {
      const parts = text.split('|').map((s) => s.trim());
      if (parts.length !== 3 || !/^https?:\/\/.+/i.test(parts[1]) || !Number.isFinite(Number(parts[2])) || Number(parts[2]) <= 0) {
        await sendMsg(token, chatId, '❌ Format: <code>Task Title | https://link.com | Reward</code>');
        return;
      }
      this.db
        .prepare('INSERT INTO child_tasks (bot_db_id, title, url, reward, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .run(bot.id, parts[0], parts[1], Number(parts[2]), Math.floor(Date.now() / 1000));
      this.db.prepare("UPDATE child_users SET state = '' WHERE id = ?").run(user.id);
      await sendMsg(token, chatId, `✅ Task added: <b>${esc(parts[0])}</b>`);
      await this.sendChildTasksAdminMenu(bot, chatId);
      return;
    }

    if (state === 'ca_promo_add') {
      const parts = text.split('|').map((s) => s.trim());
      if (parts.length !== 3 || !parts[0] || !Number.isFinite(Number(parts[1])) || Number(parts[1]) <= 0 || !/^\d+$/.test(parts[2])) {
        await sendMsg(token, chatId, '❌ Format: <code>CODE | Reward | MaxUses</code> (e.g. <code>BONUS5 | 5 | 100</code>)');
        return;
      }
      this.db
        .prepare(
          'INSERT INTO child_promos (bot_db_id, code, reward, max_uses, used_count, created_at) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(bot_db_id, code) DO UPDATE SET reward = excluded.reward, max_uses = excluded.max_uses'
        )
        .run(bot.id, parts[0].toUpperCase(), Number(parts[1]), Number(parts[2]), Math.floor(Date.now() / 1000));
      this.db.prepare("UPDATE child_users SET state = '' WHERE id = ?").run(user.id);
      await sendMsg(token, chatId, `✅ Gift Code <code>${esc(parts[0].toUpperCase())}</code> created!`);
      await this.sendChildPromosAdminMenu(bot, chatId);
      return;
    }

    if (state === 'ca_find_user') {
      const q = text.trim().replace(/^@/, '');
      const target = /^\d+$/.test(q)
        ? (this.db.prepare('SELECT * FROM child_users WHERE bot_db_id = ? AND user_id = ?').get(bot.id, Number(q)) as unknown as
            | ChildUserRow
            | undefined)
        : (this.db
            .prepare('SELECT * FROM child_users WHERE bot_db_id = ? AND LOWER(username) = LOWER(?)')
            .get(bot.id, q) as unknown as ChildUserRow | undefined);
      this.db.prepare("UPDATE child_users SET state = '' WHERE id = ?").run(user.id);
      if (!target) {
        await sendMsg(token, chatId, '❌ User not found in this bot.');
        return;
      }
      await this.sendChildAdminUserCard(bot, chatId, target.user_id);
      return;
    }

    if (state === 'ca_add_bal' || state === 'ca_sub_bal') {
      const tid = Number(stateData.target_id || 0);
      const amt = Number(text);
      if (!Number.isFinite(amt) || amt <= 0) {
        await sendMsg(token, chatId, '❌ Enter a valid positive amount.');
        return;
      }
      const cleanAmt = Math.round(amt * 100) / 100;
      this.db.prepare("UPDATE child_users SET state = '', state_data = '' WHERE id = ?").run(user.id);
      if (state === 'ca_add_bal') {
        this.db
          .prepare(
            'UPDATE child_users SET balance = ROUND(balance + ?, 2), total_earned = ROUND(total_earned + ?, 2) WHERE bot_db_id = ? AND user_id = ?'
          )
          .run(cleanAmt, cleanAmt, bot.id, tid);
        await sendMsg(token, tid, `💵 Admin added <b>+${esc(fmtAmount(bot.currency, cleanAmt))}</b> to your balance!`);
      } else {
        this.db
          .prepare('UPDATE child_users SET balance = MAX(0, ROUND(balance - ?, 2)) WHERE bot_db_id = ? AND user_id = ?')
          .run(cleanAmt, bot.id, tid);
      }
      await this.sendChildAdminUserCard(bot, chatId, tid, true);
      return;
    }

    // Unlimited Child Force Channels (supports multiple lines!)
    if (state === 'ca_add_channel') {
      const lines = text
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      let added = 0;
      const errors: string[] = [];
      for (const line of lines) {
        const res = await resolveChannelInput(token, line);
        if (!res.ok) {
          errors.push(`${esc(line)}: ${res.error}`);
        } else {
          this.db
            .prepare(
              'INSERT INTO child_channels (bot_db_id, chat_id, title, invite_link, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(bot_db_id, chat_id) DO UPDATE SET title = excluded.title, invite_link = excluded.invite_link'
            )
            .run(bot.id, res.chatId, res.title, res.inviteLink, Math.floor(Date.now() / 1000));
          added++;
        }
      }
      this.db.prepare("UPDATE child_users SET state = '' WHERE id = ?").run(user.id);
      await sendMsg(
        token,
        chatId,
        `✅ Added <b>${added}</b> channel(s).` + (errors.length > 0 ? `\n\n⚠️ Errors:\n${errors.join('\n')}` : '')
      );
      await this.sendChildChannelsMenu(bot, chatId, 0);
      return;
    }

    if (state.startsWith('ca_set:')) {
      const field = state.slice(7);
      const val = text.trim();
      if (field === 'per_refer' || field === 'min_withdraw' || field === 'daily_bonus' || field === 'gmail_sell_price') {
        const num = Number(val);
        if (!Number.isFinite(num) || num < 0) {
          await sendMsg(token, chatId, '❌ Enter a valid non-negative number.');
          return;
        }
        this.db.prepare(`UPDATE bots SET ${field} = ? WHERE id = ?`).run(Math.round(num * 100) / 100, bot.id);
      } else if (field === 'support_username') {
        this.db.prepare(`UPDATE bots SET ${field} = ? WHERE id = ?`).run(val, bot.id);
      }
      this.db.prepare("UPDATE child_users SET state = '' WHERE id = ?").run(user.id);
      const freshBot = this.db.prepare('SELECT * FROM bots WHERE id = ?').get(bot.id) as unknown as BotRow;
      await sendMsg(token, chatId, `✅ Updated <b>${esc(field)}</b>.`);
      await this.sendChildSettingsMenu(freshBot, chatId);
      return;
    }

    if (state === 'ca_bc_msg') {
      this.db
        .prepare("UPDATE child_users SET state = 'ca_bc_btn', state_data = ? WHERE id = ?")
        .run(JSON.stringify({ msg: text }), user.id);
      await sendMsg(token, chatId, '🔘 Optional button: send <code>Label | https://url.com</code> or send <code>skip</code>:');
      return;
    }

    if (state === 'ca_bc_btn') {
      let btn: { text: string; url: string } | null = null;
      if (text.toLowerCase() !== 'skip') {
        if (!text.includes('|')) {
          await sendMsg(token, chatId, '❌ Invalid format. Use <code>Label | https://url.com</code> or <code>skip</code>.');
          return;
        }
        const [lbl, url] = text.split('|', 2).map((s) => s.trim());
        if (!/^https?:\/\/.+/i.test(url)) {
          await sendMsg(token, chatId, '❌ Invalid URL.');
          return;
        }
        btn = { text: lbl, url };
      }
      stateData.btn = btn;
      this.db.prepare("UPDATE child_users SET state = '', state_data = ? WHERE id = ?").run(JSON.stringify(stateData), user.id);
      await sendMsg(token, chatId, `📋 <b>Broadcast Preview</b>\n\n${String(stateData.msg || '')}`, {
        inline_keyboard: [
          [{ text: '✅ Send to All Users', callback_data: 'ca_bc_exec', style: 'success' }],
          [{ text: '❌ Cancel', callback_data: 'ca_home', style: 'danger' }],
        ],
      });
    }
  }

  private async handleChildCallback(
    bot: BotRow,
    user: ChildUserRow,
    cb: { id: string; message?: { chat: { id: number }; message_id: number }; data?: string }
  ): Promise<void> {
    if (!cb.message) return;
    const token = bot.token;
    const chatId = cb.message.chat.id;
    const msgId = cb.message.message_id;
    const data = cb.data || '';
    const curr = bot.currency;

    if (data === 'c_check_dev') {
      if (user.device_verified === 1) {
        await answerCb(token, cb.id, 'Verified!');
        await tgApi(token, 'deleteMessage', { chat_id: chatId, message_id: msgId });
        await this.sendChildHome(bot, user, chatId);
      } else {
        await answerCb(token, cb.id, 'Please open Verify My Device link first!', true);
      }
      return;
    }

    if (data === 'c_wd_full') {
      await answerCb(token, cb.id);
      await tgApi(token, 'deleteMessage', { chat_id: chatId, message_id: msgId });
      await this.processChildWithdraw(bot, user, chatId, user.balance);
      return;
    }

    if (data.startsWith('c_star_pack:')) {
      const packAmt = Number(data.slice(12));
      if (!Number.isFinite(packAmt) || packAmt <= 0) {
        await answerCb(token, cb.id, 'Invalid pack.', true);
        return;
      }
      await answerCb(token, cb.id);
      await tgApi(token, 'deleteMessage', { chat_id: chatId, message_id: msgId });
      await this.processChildWithdraw(bot, user, chatId, packAmt, `${packAmt} ⭐ Telegram Star Gift Pack`);
      return;
    }

    if (data.startsWith('c_redeem:')) {
      const planId = Number(data.slice(9));
      const res = withTx(this.db, () => {
        const plan = this.db
          .prepare('SELECT * FROM redeem_plans WHERE id = ? AND bot_db_id = ? AND is_active = 1')
          .get(planId, bot.id) as unknown as RedeemPlanRow | undefined;
        if (!plan) return { ok: false as const, err: 'Plan unavailable.' };
        const freshUser = this.db.prepare('SELECT balance FROM child_users WHERE id = ?').get(user.id) as { balance: number };
        if (freshUser.balance < plan.cost) {
          return { ok: false as const, err: `Insufficient balance (need ${curr}${fmtNum(plan.cost)}).` };
        }
        const codeRow = this.db
          .prepare('SELECT id, code FROM redeem_codes WHERE plan_id = ? AND bot_db_id = ? AND is_used = 0 LIMIT 1')
          .get(plan.id, bot.id) as { id: number; code: string } | undefined;
        if (!codeRow) {
          return { ok: false as const, err: 'Out of stock! Ask bot admin to restock codes.' };
        }
        this.db.prepare('UPDATE child_users SET balance = ROUND(balance - ?, 2), total_withdrawn = ROUND(total_withdrawn + ?, 2) WHERE id = ?')
          .run(plan.cost, plan.cost, user.id);
        this.db
          .prepare('UPDATE redeem_codes SET is_used = 1, used_by = ?, used_at = ? WHERE id = ?')
          .run(user.user_id, Math.floor(Date.now() / 1000), codeRow.id);
        return { ok: true as const, code: codeRow.code, title: plan.title, cost: plan.cost };
      });
      if (!res.ok) {
        await answerCb(token, cb.id, res.err, true);
        return;
      }
      await answerCb(token, cb.id, 'Code redeemed!');
      await sendMsg(
        token,
        chatId,
        `🎉 <b>Redeem Code Delivered!</b>\n\n🎟 Plan: <b>${esc(res.title)}</b>\n💵 Cost: <code>${esc(curr)}${fmtNum(res.cost)}</code>\n🔑 Your Code: <code>${esc(res.code)}</code>`,
        this.childMainKeyboard(bot, user.user_id)
      );
      return;
    }

    if (data === 'c_dep_start') {
      if (bot.deposit_enabled === 0) {
        await answerCb(token, cb.id, 'Deposits are closed.', true);
        return;
      }
      await answerCb(token, cb.id);
      this.db.prepare("UPDATE child_users SET state = 'c_dep_amt' WHERE id = ?").run(user.id);
      await sendMsg(
        token,
        chatId,
        `💵 Enter deposit amount in <b>₹</b> (minimum <b>${esc(fmtAmount(curr, bot.min_deposit || 10))}</b>):`,
        { keyboard: [[{ text: '❌ Cancel', style: 'danger' }]], resize_keyboard: true }
      );
      return;
    }

    if (data.startsWith('c_gbuy:')) {
      const planId = Number(data.slice(7));
      const res = withTx(this.db, () => {
        const plan = this.db
          .prepare('SELECT * FROM gmail_plans WHERE id = ? AND bot_db_id = ? AND is_active = 1')
          .get(planId, bot.id) as unknown as GmailPlanRow | undefined;
        if (!plan) return { ok: false as const, err: 'Gmail plan unavailable.' };
        const freshUser = this.db.prepare('SELECT balance FROM child_users WHERE id = ?').get(user.id) as { balance: number };
        if (freshUser.balance < plan.price) {
          return { ok: false as const, err: `Insufficient balance (need ${fmtAmount(curr, plan.price)}). Tap 💳 Deposit to add funds.` };
        }
        const row = this.db
          .prepare('SELECT id, account_data FROM gmail_stock WHERE plan_id = ? AND bot_db_id = ? AND is_sold = 0 LIMIT 1')
          .get(plan.id, bot.id) as { id: number; account_data: string } | undefined;
        if (!row) {
          return { ok: false as const, err: 'Out of stock! Ask bot admin to restock Gmails.' };
        }
        this.db
          .prepare('UPDATE child_users SET balance = ROUND(balance - ?, 2), total_withdrawn = ROUND(total_withdrawn + ?, 2) WHERE id = ?')
          .run(plan.price, plan.price, user.id);
        this.db
          .prepare('UPDATE gmail_stock SET is_sold = 1, sold_to = ?, sold_at = ? WHERE id = ?')
          .run(user.user_id, Math.floor(Date.now() / 1000), row.id);
        return { ok: true as const, account: row.account_data, title: plan.title, price: plan.price };
      });
      if (!res.ok) {
        await answerCb(token, cb.id, res.err, true);
        return;
      }
      await answerCb(token, cb.id, 'Gmail delivered!');
      await sendMsg(
        token,
        chatId,
        `🎉 <b>Gmail Purchased Successfully!</b>\n\n` +
          `<blockquote>📧 Plan: <b>${esc(res.title)}</b>\n` +
          `💵 Price: <code>${esc(fmtAmount(curr, res.price))}</code>\n` +
          `🔑 Credentials:\n<code>${esc(res.account)}</code></blockquote>`,
        this.childMainKeyboard(bot, user.user_id)
      );
      return;
    }

    if (data.startsWith('c_task:')) {
      const taskId = Number(data.slice(7));
      const res = withTx(this.db, () => {
        const task = this.db
          .prepare('SELECT * FROM child_tasks WHERE id = ? AND bot_db_id = ? AND is_active = 1')
          .get(taskId, bot.id) as unknown as ChildTaskRow | undefined;
        if (!task) return { ok: false as const, err: 'Task no longer active.' };
        const dup = this.db
          .prepare('SELECT 1 FROM child_task_claims WHERE bot_db_id = ? AND task_id = ? AND user_id = ?')
          .get(bot.id, taskId, user.user_id);
        if (dup) return { ok: false as const, err: 'Already claimed!' };
        this.db
          .prepare('INSERT INTO child_task_claims (bot_db_id, task_id, user_id, claimed_at) VALUES (?, ?, ?, ?)')
          .run(bot.id, taskId, user.user_id, Math.floor(Date.now() / 1000));
        this.db
          .prepare('UPDATE child_users SET balance = balance + ?, total_earned = total_earned + ? WHERE id = ?')
          .run(task.reward, task.reward, user.id);
        return { ok: true as const, reward: task.reward, title: task.title };
      });
      if (!res.ok) {
        await answerCb(token, cb.id, res.err, true);
        return;
      }
      await answerCb(token, cb.id, `Earned +${fmtAmount(curr, res.reward)}!`);
      await editMsg(token, chatId, msgId, `✅ Completed: <b>${esc(res.title)}</b> (+${esc(fmtAmount(curr, res.reward))})`);
      return;
    }

    // Child Admin Callbacks Only
    if (!this.isChildAdmin(bot, user.user_id)) {
      await answerCb(token, cb.id, 'Admin only.', true);
      return;
    }

    if (data === 'ca_home') {
      this.db.prepare("UPDATE child_users SET state = '', state_data = '' WHERE id = ?").run(user.id);
      await answerCb(token, cb.id);
      await this.sendChildAdminMenu(bot, chatId, msgId);
      return;
    }

    if (data === 'ca_admins') {
      await answerCb(token, cb.id);
      await this.sendChildAdminsMenu(bot, chatId, msgId);
      return;
    }

    if (data === 'ca_admin_add') {
      await answerCb(token, cb.id);
      this.db.prepare("UPDATE child_users SET state = 'ca_admin_add' WHERE id = ?").run(user.id);
      await sendMsg(token, chatId, '👮 Send numeric <b>Telegram User ID</b> to add as Bot Admin:');
      return;
    }

    if (data.startsWith('ca_admin_del:')) {
      const remId = Number(data.slice(13));
      this.db.prepare('DELETE FROM child_admins WHERE bot_db_id = ? AND user_id = ?').run(bot.id, remId);
      await answerCb(token, cb.id, 'Admin removed.');
      await this.sendChildAdminsMenu(bot, chatId, msgId);
      return;
    }

    if (data === 'ca_plans') {
      await answerCb(token, cb.id);
      await this.sendChildPlansMenu(bot, chatId, msgId);
      return;
    }

    if (data === 'ca_plan_add') {
      await answerCb(token, cb.id);
      this.db.prepare("UPDATE child_users SET state = 'ca_plan_add' WHERE id = ?").run(user.id);
      await sendMsg(token, chatId, '🎟 Send format: <code>Plan Title | Cost</code>\nExample: <code>₹10 Play Code | 10</code>');
      return;
    }

    if (data.startsWith('ca_plan_v:')) {
      await answerCb(this.tokenFor(bot), cb.id);
      const pid = Number(data.slice(10));
      const p = this.db
        .prepare(
          'SELECT rp.*, (SELECT COUNT(*) FROM redeem_codes rc WHERE rc.plan_id = rp.id AND rc.is_used = 0) AS stock_count FROM redeem_plans rp WHERE rp.id = ? AND rp.bot_db_id = ?'
        )
        .get(pid, bot.id) as unknown as RedeemPlanRow | undefined;
      if (!p) return;
      await editMsg(
        token,
        chatId,
        msgId,
        `🎟 <b>${esc(p.title)}</b>\n💵 Cost: <code>${esc(curr)}${fmtNum(p.cost)}</code>\n📦 Available Stock: <code>${p.stock_count ?? 0}</code>`,
        {
          inline_keyboard: [
            [{ text: '📥 Add Redeem Codes', callback_data: `ca_plan_codes:${pid}`, style: 'success' }],
            [
              { text: '🗑 Delete Plan', callback_data: `ca_plan_del:${pid}`, style: 'danger' },
              { text: '⬅️ Plans', callback_data: 'ca_plans', style: 'primary' },
            ],
          ],
        }
      );
      return;
    }

    if (data.startsWith('ca_plan_codes:')) {
      await answerCb(token, cb.id);
      const pid = Number(data.slice(14));
      this.db
        .prepare("UPDATE child_users SET state = 'ca_plan_codes', state_data = ? WHERE id = ?")
        .run(JSON.stringify({ plan_id: pid }), user.id);
      await sendMsg(token, chatId, '📥 Send your <b>Redeem Codes</b> (one code per line, unlimited!):');
      return;
    }

    if (data.startsWith('ca_plan_del:')) {
      const pid = Number(data.slice(12));
      this.db.prepare('DELETE FROM redeem_plans WHERE id = ? AND bot_db_id = ?').run(pid, bot.id);
      await answerCb(token, cb.id, 'Plan deleted.');
      await this.sendChildPlansMenu(bot, chatId, msgId);
      return;
    }

    if (data === 'ca_tasks') {
      await answerCb(token, cb.id);
      await this.sendChildTasksAdminMenu(bot, chatId, msgId);
      return;
    }

    if (data === 'ca_task_add') {
      await answerCb(token, cb.id);
      this.db.prepare("UPDATE child_users SET state = 'ca_task_add' WHERE id = ?").run(user.id);
      await sendMsg(token, chatId, '📋 Send format: <code>Title | https://url.com | Reward</code>');
      return;
    }

    if (data.startsWith('ca_task_del:')) {
      const tid = Number(data.slice(12));
      this.db.prepare('DELETE FROM child_tasks WHERE id = ? AND bot_db_id = ?').run(tid, bot.id);
      await answerCb(token, cb.id, 'Task deleted.');
      await this.sendChildTasksAdminMenu(bot, chatId, msgId);
      return;
    }

    if (data === 'ca_promos') {
      await answerCb(token, cb.id);
      await this.sendChildPromosAdminMenu(bot, chatId, msgId);
      return;
    }

    if (data === 'ca_promo_add') {
      await answerCb(token, cb.id);
      this.db.prepare("UPDATE child_users SET state = 'ca_promo_add' WHERE id = ?").run(user.id);
      await sendMsg(token, chatId, '🎫 Send format: <code>CODE | Reward | MaxUses</code>\nExample: <code>WELCOME5 | 5 | 50</code>');
      return;
    }

    if (data.startsWith('ca_promo_del:')) {
      const pid = Number(data.slice(13));
      this.db.prepare('DELETE FROM child_promos WHERE id = ? AND bot_db_id = ?').run(pid, bot.id);
      await answerCb(token, cb.id, 'Gift code deleted.');
      await this.sendChildPromosAdminMenu(bot, chatId, msgId);
      return;
    }

    if (data === 'ca_stats') {
      await answerCb(token, cb.id);
      const now = Math.floor(Date.now() / 1000);
      const uTotal = Number((this.db.prepare('SELECT COUNT(*) AS c FROM child_users WHERE bot_db_id = ?').get(bot.id) as { c: number }).c);
      const uActive = Number(
        (this.db.prepare('SELECT COUNT(*) AS c FROM child_users WHERE bot_db_id = ? AND last_active_at >= ?').get(bot.id, now - 86400) as {
          c: number;
        }).c
      );
      const devVer = Number(
        (this.db.prepare('SELECT COUNT(*) AS c FROM child_users WHERE bot_db_id = ? AND device_verified = 1').get(bot.id) as { c: number }).c
      );
      const balSum = Number(
        (this.db.prepare('SELECT COALESCE(SUM(balance),0) AS s FROM child_users WHERE bot_db_id = ?').get(bot.id) as { s: number }).s
      );
      const paidSum = Number(
        (this.db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE bot_db_id = ? AND status = 'paid'").get(bot.id) as {
          s: number;
        }).s
      );
      const pendCnt = Number(
        (this.db.prepare("SELECT COUNT(*) AS c FROM withdrawals WHERE bot_db_id = ? AND status = 'pending'").get(bot.id) as { c: number }).c
      );

      const isStar = isStarBotType(bot.bot_type);
      const txt =
        `📊 <b>Bot Status &amp; Analytics</b>\n\n` +
        `<blockquote>` +
        `👥 <b>Total Users:</b> <code>${uTotal}</code>\n` +
        `🟢 <b>Active (24h):</b> <code>${uActive}</code>\n` +
        `📱 <b>Verified Devices:</b> <code>${devVer}</code>\n` +
        `${isStar ? '⭐' : '💵'} <b>Unclaimed User Wallets:</b> <code>${esc(fmtAmount(curr, balSum))}</code>\n` +
        `✅ <b>Total ${isStar ? 'Stars Sent' : 'Paid Out'}:</b> <code>${esc(fmtAmount(curr, paidSum))}</code>\n` +
        `⏳ <b>Pending Withdrawals:</b> <code>${pendCnt}</code>` +
        `</blockquote>`;
      await editMsg(token, chatId, msgId, txt, {
        inline_keyboard: [
          [
            { text: '🔄 Refresh', callback_data: 'ca_stats', style: 'success' },
            { text: isStar ? '🌟 Star Queue' : '💸 Pending Queue', callback_data: 'ca_wds:0', style: 'primary' },
          ],
          [{ text: '⬅️ Admin Menu', callback_data: 'ca_home', style: 'primary' }],
        ],
      });
      return;
    }

    if (data.startsWith('ca_wds:')) {
      await answerCb(token, cb.id);
      const isStar = isStarBotType(bot.bot_type);
      const offset = Math.max(0, Number(data.slice(7)));
      const w = this.db
        .prepare(
          `SELECT w.*, cu.first_name, cu.username
           FROM withdrawals w
           LEFT JOIN child_users cu ON cu.bot_db_id = w.bot_db_id AND cu.user_id = w.user_id
           WHERE w.bot_db_id = ? AND w.status = 'pending'
           ORDER BY w.id ASC LIMIT 1 OFFSET ?`
        )
        .get(bot.id, offset) as unknown as WithdrawalRow | undefined;
      const totalPend = Number(
        (this.db.prepare("SELECT COUNT(*) AS c FROM withdrawals WHERE bot_db_id = ? AND status = 'pending'").get(bot.id) as { c: number }).c
      );
      if (!w) {
        await editMsg(token, chatId, msgId, `${isStar ? '🌟' : '💸'} <b>Pending Withdrawals</b>\n\nNo pending withdrawal requests.`, {
          inline_keyboard: [[{ text: '⬅️ Admin Menu', callback_data: 'ca_home', style: 'primary' }]],
        });
        return;
      }
      const uname = w.username ? `@${esc(w.username)}` : esc(w.first_name || 'User');
      const txt =
        `${isStar ? '🌟 <b>Pending Star Withdrawal' : '💸 <b>Pending Withdrawal'} (${offset + 1}/${totalPend})</b>\n\n` +
        `<blockquote>` +
        `🎫 Ticket: <code>#${w.id}</code>\n` +
        `👤 User: <b>${uname}</b> (<code>${w.user_id}</code>)\n` +
        `${isStar ? '⭐ Stars' : '💵 Amount'}: <b>${esc(fmtAmount(curr, w.amount))}</b>` +
        (w.note ? `\n🎁 Pack: <b>${esc(w.note)}</b>` : '') +
        `\n${isStar ? '🎯 Send To' : '🏦 UPI ID'}: <code>${esc(w.upi_id)}</code>\n` +
        `🕒 Requested: ${fmtDateShort(w.created_at)}` +
        `</blockquote>`;
      const kbRows: Array<Array<{ text: string; callback_data?: string; url?: string; style?: TgButtonStyle }>> = [
        [
          { text: isStar ? '✅ Approve (Stars Sent)' : '✅ Approve (Paid)', callback_data: `ca_wd_ok:${w.id}`, style: 'success' },
          { text: '❌ Reject (Refund)', callback_data: `ca_wd_no:${w.id}`, style: 'danger' },
        ],
      ];
      if (isStar && w.upi_id.startsWith('@')) {
        kbRows.push([{ text: `👤 Open ${w.upi_id}`, url: `https://t.me/${w.upi_id.slice(1)}`, style: 'primary' }]);
      }
      const nav: Array<{ text: string; callback_data: string; style?: TgButtonStyle }> = [];
      if (offset > 0) nav.push({ text: '⬅️ Prev', callback_data: `ca_wds:${offset - 1}`, style: 'primary' });
      if (offset + 1 < totalPend) nav.push({ text: 'Next ➡️', callback_data: `ca_wds:${offset + 1}`, style: 'primary' });
      if (nav.length > 0) kbRows.push(nav);
      kbRows.push([{ text: '⬅️ Admin Menu', callback_data: 'ca_home', style: 'primary' }]);
      await editMsg(token, chatId, msgId, txt, { inline_keyboard: kbRows });
      return;
    }

    if (data.startsWith('ca_wd_ok:') || data.startsWith('ca_wd_no:')) {
      const isApprove = data.startsWith('ca_wd_ok:');
      const isStar = isStarBotType(bot.bot_type);
      const wdId = Number(data.slice(9));
      const res = withTx(this.db, () => {
        const w = this.db.prepare('SELECT * FROM withdrawals WHERE id = ? AND bot_db_id = ?').get(wdId, bot.id) as unknown as
          | WithdrawalRow
          | undefined;
        if (!w || w.status !== 'pending') return null;
        this.db
          .prepare('UPDATE withdrawals SET status = ?, processed_at = ? WHERE id = ?')
          .run(isApprove ? 'paid' : 'rejected', Math.floor(Date.now() / 1000), wdId);
        if (isApprove) {
          this.db
            .prepare('UPDATE child_users SET total_withdrawn = ROUND(total_withdrawn + ?, 2) WHERE bot_db_id = ? AND user_id = ?')
            .run(w.amount, bot.id, w.user_id);
        } else {
          this.db
            .prepare('UPDATE child_users SET balance = ROUND(balance + ?, 2) WHERE bot_db_id = ? AND user_id = ?')
            .run(w.amount, bot.id, w.user_id);
        }
        return w;
      });
      if (!res) {
        await answerCb(token, cb.id, 'Already processed.', true);
        return;
      }
      await answerCb(token, cb.id, isApprove ? (isStar ? 'Stars Sent!' : 'Marked as Paid!') : 'Rejected & Refunded!');
      const badge = isApprove ? (isStar ? '✅ Approved &amp; Stars Sent' : '✅ Approved &amp; Paid') : '❌ Rejected (Refunded)';
      await editMsg(
        token,
        chatId,
        msgId,
        `🎫 <b>${isStar ? 'Star Withdrawal' : 'Withdrawal'} #${wdId}</b>\n${isStar ? '⭐ Stars' : '💵 Amount'}: <b>${esc(fmtAmount(curr, res.amount))}</b>\n${isStar ? '👤 Receiver' : '🏦 UPI'}: <code>${esc(res.upi_id)}</code>\n\nResult: <b>${badge}</b>`,
        {
          inline_keyboard: [
            [
              { text: isStar ? '🌟 Next Pending' : '💸 Next Pending', callback_data: 'ca_wds:0', style: 'success' },
              { text: '⬅️ Admin Menu', callback_data: 'ca_home', style: 'primary' },
            ],
          ],
        }
      );
      await sendMsg(
        token,
        res.user_id,
        isApprove
          ? `✅ <b>${isStar ? 'Stars Sent!' : 'Withdrawal Approved!'}</b>\n\n🎫 Ticket: <code>#${wdId}</code>\n${isStar ? '⭐ Stars' : '💵 Amount'}: <b>${esc(fmtAmount(curr, res.amount))}</b>\n${isStar ? '👤 Receiver' : '🏦 UPI'}: <code>${esc(res.upi_id)}</code>`
          : `❌ <b>Withdrawal Rejected</b>\n\n🎫 Ticket: <code>#${wdId}</code>\n${isStar ? '⭐' : '💵'} <b>${esc(fmtAmount(curr, res.amount))}</b> refunded to your wallet.`
      );
      return;
    }

    if (data === 'ca_gplans') {
      await answerCb(token, cb.id);
      await this.sendGmailPlansAdminMenu(bot, chatId, msgId);
      return;
    }

    if (data === 'ca_gplan_add') {
      await answerCb(token, cb.id);
      this.db.prepare("UPDATE child_users SET state = 'ca_gplan_add' WHERE id = ?").run(user.id);
      await sendMsg(token, chatId, '📧 Send format: <code>Plan Title | Price</code>\nExample: <code>Fresh Gmail | 15</code>');
      return;
    }

    if (data.startsWith('ca_gplan_v:')) {
      await answerCb(token, cb.id);
      const pid = Number(data.slice(11));
      const p = this.db
        .prepare(
          'SELECT gp.*, (SELECT COUNT(*) FROM gmail_stock gs WHERE gs.plan_id = gp.id AND gs.is_sold = 0) AS stock_count FROM gmail_plans gp WHERE gp.id = ? AND gp.bot_db_id = ?'
        )
        .get(pid, bot.id) as unknown as GmailPlanRow | undefined;
      if (!p) return;
      await editMsg(
        token,
        chatId,
        msgId,
        `📧 <b>${esc(p.title)}</b>\n💵 Buy Price: <code>${esc(fmtAmount(curr, p.price))}</code>\n📦 Available Stock: <code>${p.stock_count ?? 0}</code>`,
        {
          inline_keyboard: [
            [{ text: '📥 Add Gmail Stock', callback_data: `ca_gplan_stock:${pid}`, style: 'success' }],
            [
              { text: '🗑 Delete Plan', callback_data: `ca_gplan_del:${pid}`, style: 'danger' },
              { text: '⬅️ Gmail Plans', callback_data: 'ca_gplans', style: 'primary' },
            ],
          ],
        }
      );
      return;
    }

    if (data.startsWith('ca_gplan_stock:')) {
      await answerCb(token, cb.id);
      const pid = Number(data.slice(15));
      this.db
        .prepare("UPDATE child_users SET state = 'ca_gplan_stock', state_data = ? WHERE id = ?")
        .run(JSON.stringify({ plan_id: pid }), user.id);
      await sendMsg(
        token,
        chatId,
        '📥 Send Gmail accounts to add to stock (one per line, unlimited):\n<code>email@gmail.com | Password123</code>'
      );
      return;
    }

    if (data.startsWith('ca_gplan_del:')) {
      const pid = Number(data.slice(13));
      this.db.prepare('DELETE FROM gmail_plans WHERE id = ? AND bot_db_id = ?').run(pid, bot.id);
      await answerCb(token, cb.id, 'Gmail plan deleted.');
      await this.sendGmailPlansAdminMenu(bot, chatId, msgId);
      return;
    }

    if (data.startsWith('ca_gsells:')) {
      await answerCb(token, cb.id);
      const offset = Math.max(0, Number(data.slice(10)));
      const s = this.db
        .prepare(
          `SELECT g.*, cu.first_name, cu.username FROM gmail_sell_requests g
           LEFT JOIN child_users cu ON cu.bot_db_id = g.bot_db_id AND cu.user_id = g.user_id
           WHERE g.bot_db_id = ? AND g.status = 'pending' ORDER BY g.id ASC LIMIT 1 OFFSET ?`
        )
        .get(bot.id, offset) as unknown as GmailSellRow | undefined;
      const tot = Number(
        (this.db.prepare("SELECT COUNT(*) AS c FROM gmail_sell_requests WHERE bot_db_id = ? AND status = 'pending'").get(bot.id) as { c: number }).c
      );
      if (!s) {
        await editMsg(token, chatId, msgId, '📤 <b>Gmail Sell Requests</b>\n\nNo pending Gmail sell submissions.', {
          inline_keyboard: [[{ text: '⬅️ Admin Menu', callback_data: 'ca_home', style: 'primary' }]],
        });
        return;
      }
      const uname = s.username ? `@${esc(s.username)}` : esc(s.first_name || 'User');
      const txt =
        `📤 <b>Gmail Sell Request (${offset + 1}/${tot})</b>\n\n` +
        `<blockquote>🎫 ID: <code>#${s.id}</code>\n` +
        `👤 Seller: <b>${uname}</b> (<code>${s.user_id}</code>)\n` +
        `💵 Payout: <b>${esc(fmtAmount(curr, s.price))}</b>\n` +
        `📧 Account: <code>${esc(s.account_data)}</code></blockquote>`;
      const rows: Array<Array<{ text: string; callback_data: string; style?: TgButtonStyle }>> = [
        [
          { text: `✅ Approve (+${fmtAmount(curr, s.price)})`, callback_data: `ca_gsell_ok:${s.id}`, style: 'success' },
          { text: '❌ Reject', callback_data: `ca_gsell_no:${s.id}`, style: 'danger' },
        ],
        [{ text: '📦 Approve & Add to Stock', callback_data: `ca_gsell_stk:${s.id}`, style: 'primary' }],
      ];
      const nav: Array<{ text: string; callback_data: string; style?: TgButtonStyle }> = [];
      if (offset > 0) nav.push({ text: '⬅️ Prev', callback_data: `ca_gsells:${offset - 1}`, style: 'primary' });
      if (offset + 1 < tot) nav.push({ text: 'Next ➡️', callback_data: `ca_gsells:${offset + 1}`, style: 'primary' });
      if (nav.length > 0) rows.push(nav);
      rows.push([{ text: '⬅️ Admin Menu', callback_data: 'ca_home', style: 'primary' }]);
      await editMsg(token, chatId, msgId, txt, { inline_keyboard: rows });
      return;
    }

    if (data.startsWith('ca_gsell_ok:') || data.startsWith('ca_gsell_stk:') || data.startsWith('ca_gsell_no:')) {
      const isStock = data.startsWith('ca_gsell_stk:');
      const isOk = isStock || data.startsWith('ca_gsell_ok:');
      const sid = Number(data.split(':')[1]);
      const now = Math.floor(Date.now() / 1000);
      const res = withTx(this.db, () => {
        const s = this.db
          .prepare('SELECT * FROM gmail_sell_requests WHERE id = ? AND bot_db_id = ?')
          .get(sid, bot.id) as unknown as GmailSellRow | undefined;
        if (!s || s.status !== 'pending') return null;
        this.db
          .prepare('UPDATE gmail_sell_requests SET status = ?, processed_by = ?, processed_at = ? WHERE id = ?')
          .run(isOk ? 'approved' : 'rejected', user.user_id, now, sid);
        if (isOk) {
          this.db
            .prepare('UPDATE child_users SET balance = ROUND(balance + ?, 2), total_earned = ROUND(total_earned + ?, 2) WHERE bot_db_id = ? AND user_id = ?')
            .run(s.price, s.price, bot.id, s.user_id);
          if (isStock) {
            let plan = this.db
              .prepare('SELECT id FROM gmail_plans WHERE bot_db_id = ? AND is_active = 1 ORDER BY id ASC LIMIT 1')
              .get(bot.id) as { id: number } | undefined;
            if (!plan) {
              const pIns = this.db
                .prepare('INSERT INTO gmail_plans (bot_db_id, title, price, is_active, created_at) VALUES (?, ?, ?, 1, ?)')
                .run(bot.id, 'Fresh Gmail', Math.max(s.price * 2, 10), now);
              plan = { id: Number(pIns.lastInsertRowid) };
            }
            this.db
              .prepare('INSERT INTO gmail_stock (bot_db_id, plan_id, account_data, is_sold, created_at) VALUES (?, ?, ?, 0, ?)')
              .run(bot.id, plan.id, s.account_data, now);
          }
        }
        return s;
      });
      if (!res) {
        await answerCb(token, cb.id, 'Already processed.', true);
        return;
      }
      await answerCb(token, cb.id, isOk ? (isStock ? 'Approved & Added to Stock!' : 'Approved!') : 'Rejected!');
      await editMsg(
        token,
        chatId,
        msgId,
        isOk
          ? `✅ <b>Gmail Sell #${sid} Approved${isStock ? ' &amp; Stocked' : ''}</b> (+${esc(fmtAmount(curr, res.price))} to <code>${res.user_id}</code>)`
          : `❌ <b>Gmail Sell #${sid} Rejected</b>`,
        {
          inline_keyboard: [
            [
              { text: '📤 Next Sell Request', callback_data: 'ca_gsells:0', style: 'success' },
              { text: '⬅️ Admin Menu', callback_data: 'ca_home', style: 'primary' },
            ],
          ],
        }
      );
      await sendMsg(
        token,
        res.user_id,
        isOk
          ? `✅ <b>Gmail Accepted!</b>\n\n🎫 Request #${sid}\n💵 Credited: <b>+${esc(fmtAmount(curr, res.price))}</b> added to your wallet!`
          : `❌ <b>Gmail Rejected</b>\n\n🎫 Request #${sid} could not be verified by admin.`
      );
      return;
    }

    if (data === 'ca_deposit') {
      await answerCb(token, cb.id);
      await this.sendChildDepositAdminMenu(bot, chatId, msgId);
      return;
    }

    if (data === 'ca_dep_qr') {
      await answerCb(token, cb.id);
      this.db.prepare("UPDATE child_users SET state = 'ca_dep_qr' WHERE id = ?").run(user.id);
      await sendMsg(token, chatId, '🖼 Send your <b>Deposit QR Code Image (Photo)</b> now (or /cancel):');
      return;
    }

    if (data === 'ca_dep_upi') {
      await answerCb(token, cb.id);
      this.db.prepare("UPDATE child_users SET state = 'ca_dep_upi' WHERE id = ?").run(user.id);
      await sendMsg(token, chatId, '🏦 Send your <b>Deposit UPI ID</b> (e.g. <code>merchant@ybl</code>):');
      return;
    }

    if (data === 'ca_dep_min') {
      await answerCb(token, cb.id);
      this.db.prepare("UPDATE child_users SET state = 'ca_dep_min' WHERE id = ?").run(user.id);
      await sendMsg(token, chatId, '📉 Enter minimum deposit amount in ₹ (e.g. <code>10</code>):');
      return;
    }

    if (data === 'ca_dep_tog') {
      this.db.prepare('UPDATE bots SET deposit_enabled = CASE WHEN deposit_enabled = 1 THEN 0 ELSE 1 END WHERE id = ?').run(bot.id);
      const fresh = this.db.prepare('SELECT * FROM bots WHERE id = ?').get(bot.id) as unknown as BotRow;
      await answerCb(token, cb.id, 'Deposit status toggled.');
      await this.sendChildDepositAdminMenu(fresh, chatId, msgId);
      return;
    }

    if (data.startsWith('ca_deps:')) {
      await answerCb(token, cb.id);
      const offset = Math.max(0, Number(data.slice(8)));
      const d = this.db
        .prepare(
          `SELECT d.*, cu.first_name, cu.username FROM child_deposits d
           LEFT JOIN child_users cu ON cu.bot_db_id = d.bot_db_id AND cu.user_id = d.user_id
           WHERE d.bot_db_id = ? AND d.status = 'pending' ORDER BY d.id ASC LIMIT 1 OFFSET ?`
        )
        .get(bot.id, offset) as unknown as ChildDepositRow | undefined;
      const tot = Number(
        (this.db.prepare("SELECT COUNT(*) AS c FROM child_deposits WHERE bot_db_id = ? AND status = 'pending'").get(bot.id) as { c: number }).c
      );
      if (!d) {
        await editMsg(token, chatId, msgId, '💳 <b>Pending Bot Deposits</b>\n\nNo pending deposit requests.', {
          inline_keyboard: [[{ text: '⬅️ Deposit Menu', callback_data: 'ca_deposit', style: 'primary' }]],
        });
        return;
      }
      const uname = d.username ? `@${esc(d.username)}` : esc(d.first_name || 'User');
      const txt =
        `💳 <b>Pending Deposit (${offset + 1}/${tot})</b>\n\n` +
        `<blockquote>🎫 ID: <code>#${d.id}</code>\n` +
        `👤 User: <b>${uname}</b> (<code>${d.user_id}</code>)\n` +
        `💵 Amount: <b>${esc(fmtAmount(curr, d.amount))}</b>\n` +
        `🧾 UTR: <code>${esc(d.utr)}</code></blockquote>`;
      const rows: Array<Array<{ text: string; callback_data: string; style?: TgButtonStyle }>> = [
        [
          { text: `✅ Approve (+${fmtAmount(curr, d.amount)})`, callback_data: `ca_dep_ok:${d.id}`, style: 'success' },
          { text: '❌ Reject', callback_data: `ca_dep_no:${d.id}`, style: 'danger' },
        ],
      ];
      const nav: Array<{ text: string; callback_data: string; style?: TgButtonStyle }> = [];
      if (offset > 0) nav.push({ text: '⬅️ Prev', callback_data: `ca_deps:${offset - 1}`, style: 'primary' });
      if (offset + 1 < tot) nav.push({ text: 'Next ➡️', callback_data: `ca_deps:${offset + 1}`, style: 'primary' });
      if (nav.length > 0) rows.push(nav);
      rows.push([{ text: '⬅️ Deposit Menu', callback_data: 'ca_deposit', style: 'primary' }]);
      await editMsg(token, chatId, msgId, txt, { inline_keyboard: rows });
      return;
    }

    if (data.startsWith('ca_dep_ok:') || data.startsWith('ca_dep_no:')) {
      const isOk = data.startsWith('ca_dep_ok:');
      const depId = Number(data.slice(10));
      const res = withTx(this.db, () => {
        const d = this.db
          .prepare('SELECT * FROM child_deposits WHERE id = ? AND bot_db_id = ?')
          .get(depId, bot.id) as unknown as ChildDepositRow | undefined;
        if (!d || d.status !== 'pending') return null;
        this.db
          .prepare('UPDATE child_deposits SET status = ?, processed_by = ?, processed_at = ? WHERE id = ?')
          .run(isOk ? 'approved' : 'rejected', user.user_id, Math.floor(Date.now() / 1000), depId);
        if (isOk) {
          this.db
            .prepare('UPDATE child_users SET balance = ROUND(balance + ?, 2) WHERE bot_db_id = ? AND user_id = ?')
            .run(d.amount, bot.id, d.user_id);
        }
        return d;
      });
      if (!res) {
        await answerCb(token, cb.id, 'Already processed.', true);
        return;
      }
      await answerCb(token, cb.id, isOk ? 'Deposit credited!' : 'Rejected!');
      const statusTxt = isOk
        ? `✅ <b>Deposit #${depId} Approved</b> (+${esc(fmtAmount(curr, res.amount))} to <code>${res.user_id}</code>)`
        : `❌ <b>Deposit #${depId} Rejected</b>`;
      const editAttempt = await editMsg(token, chatId, msgId, statusTxt);
      if (!editAttempt.ok) await sendMsg(token, chatId, statusTxt);
      await sendMsg(
        token,
        res.user_id,
        isOk
          ? `✅ <b>Deposit Approved!</b>\n\n🎫 Request #${depId}\n💵 <b>+${esc(fmtAmount(curr, res.amount))}</b> added to your wallet!`
          : `❌ <b>Deposit Rejected</b>\n\n🎫 Request #${depId} (${esc(fmtAmount(curr, res.amount))}) could not be verified.`
      );
      return;
    }

    if (data.startsWith('ca_users:')) {
      await answerCb(token, cb.id);
      const page = Math.max(0, Number(data.slice(9)));
      const limit = 10;
      const offset = page * limit;
      const rows = this.db
        .prepare('SELECT * FROM child_users WHERE bot_db_id = ? ORDER BY last_active_at DESC LIMIT ? OFFSET ?')
        .all(bot.id, limit, offset) as unknown as ChildUserRow[];
      const kbRows: Array<Array<{ text: string; callback_data: string; style?: TgButtonStyle }>> = rows.map((r) => {
        const icon = r.is_banned === 1 ? '🚫' : '🟢';
        const un = r.username ? `@${r.username}` : r.first_name;
        return [{ text: `${icon} ${un} | ${fmtAmount(curr, r.balance)} | ${r.total_refs} refs`, callback_data: `ca_u_view:${r.user_id}`, style: 'primary' }];
      });
      const nav: Array<{ text: string; callback_data: string; style?: TgButtonStyle }> = [];
      if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `ca_users:${page - 1}`, style: 'primary' });
      if (rows.length === limit) nav.push({ text: 'Next ➡️', callback_data: `ca_users:${page + 1}`, style: 'primary' });
      if (nav.length > 0) kbRows.push(nav);
      kbRows.push([{ text: '⬅️ Admin Menu', callback_data: 'ca_home', style: 'primary' }]);
      await editMsg(token, chatId, msgId, `📋 <b>Users List (Page ${page + 1})</b>\nTap a user to manage:`, { inline_keyboard: kbRows });
      return;
    }

    if (data.startsWith('ca_u_view:')) {
      await answerCb(token, cb.id);
      await this.sendChildAdminUserCard(bot, chatId, Number(data.slice(10)), false, msgId);
      return;
    }

    if (data === 'ca_find_user') {
      await answerCb(token, cb.id);
      this.db.prepare("UPDATE child_users SET state = 'ca_find_user' WHERE id = ?").run(user.id);
      await sendMsg(token, chatId, '🔍 Enter User ID or @username (or /cancel):');
      return;
    }

    if (data.startsWith('ca_u_add:') || data.startsWith('ca_u_sub:')) {
      await answerCb(token, cb.id);
      const isAdd = data.startsWith('ca_u_add:');
      const tid = Number(data.slice(9));
      this.db
        .prepare('UPDATE child_users SET state = ?, state_data = ? WHERE id = ?')
        .run(isAdd ? 'ca_add_bal' : 'ca_sub_bal', JSON.stringify({ target_id: tid }), user.id);
      await sendMsg(token, chatId, `${isAdd ? '➕' : '➖'} Enter amount (${esc(curr)}) for user <code>${tid}</code>:`);
      return;
    }

    if (data.startsWith('ca_u_ban:')) {
      const tid = Number(data.slice(9));
      this.db
        .prepare('UPDATE child_users SET is_banned = CASE WHEN is_banned = 1 THEN 0 ELSE 1 END WHERE bot_db_id = ? AND user_id = ?')
        .run(bot.id, tid);
      await answerCb(token, cb.id, 'User status updated.');
      await this.sendChildAdminUserCard(bot, chatId, tid, false, msgId);
      return;
    }

    if (data === 'ca_channels') {
      await answerCb(token, cb.id);
      await this.sendChildChannelsMenu(bot, chatId, 0, msgId);
      return;
    }

    if (data.startsWith('ca_channels:')) {
      await answerCb(token, cb.id);
      await this.sendChildChannelsMenu(bot, chatId, Number(data.slice(12)), msgId);
      return;
    }

    if (data === 'ca_ch_add') {
      await answerCb(token, cb.id);
      this.db.prepare("UPDATE child_users SET state = 'ca_add_channel' WHERE id = ?").run(user.id);
      await sendMsg(
        token,
        chatId,
        '📢 <b>Add Unlimited Force Channels</b>\n\nMake this bot <b>Admin</b> in your channel(s), then send <code>@ChannelUsername</code> or <code>-100ID | https://t.me/+InviteLink</code> (multiple lines supported!):'
      );
      return;
    }

    if (data.startsWith('ca_ch_del:')) {
      const cid = Number(data.slice(10));
      this.db.prepare('DELETE FROM child_channels WHERE id = ? AND bot_db_id = ?').run(cid, bot.id);
      await answerCb(token, cb.id, 'Channel removed.');
      await this.sendChildChannelsMenu(bot, chatId, 0, msgId);
      return;
    }

    if (data === 'ca_settings') {
      await answerCb(token, cb.id);
      await this.sendChildSettingsMenu(bot, chatId, msgId);
      return;
    }

    if (data.startsWith('ca_set:')) {
      const field = data.slice(7);
      if (!['per_refer', 'min_withdraw', 'daily_bonus', 'gmail_sell_price', 'support_username'].includes(field)) {
        await answerCb(token, cb.id, 'Option disabled.', true);
        return;
      }
      await answerCb(token, cb.id);
      this.db.prepare('UPDATE child_users SET state = ? WHERE id = ?').run(`ca_set:${field}`, user.id);
      const isStar = isStarBotType(bot.bot_type);
      const unitHint = isStar ? '⭐ (Stars)' : '₹ (INR)';
      const prompt =
        field === 'per_refer'
          ? `✏️ Enter <b>Per Refer</b> reward in ${unitHint} (example: <code>${isStar ? '2' : '10'}</code>):`
          : field === 'min_withdraw'
            ? `✏️ Enter <b>Min Withdraw</b> in ${unitHint} (example: <code>${isStar ? '15' : '50'}</code>):`
            : field === 'daily_bonus'
              ? `✏️ Enter <b>Daily Bonus</b> in ${unitHint} (example: <code>${isStar ? '1' : '5'}</code>):`
              : field === 'gmail_sell_price'
                ? '✏️ Enter <b>Gmail Buy-Back / Sell Rate</b> per Gmail in ₹ (example: <code>5</code>):'
                : '✏️ Enter <b>Support Username</b> (example: <code>@Support</code>):';
      await sendMsg(token, chatId, `${prompt}\n\nSend /cancel to go back.`);
      return;
    }

    if (data.startsWith('ca_tog:')) {
      const field = data.slice(7);
      if (field === 'withdrawals_open' || field === 'maintenance' || field === 'device_verify' || field === 'gmail_sell_open') {
        this.db.prepare(`UPDATE bots SET ${field} = CASE WHEN ${field} = 1 THEN 0 ELSE 1 END WHERE id = ?`).run(bot.id);
        const fresh = this.db.prepare('SELECT * FROM bots WHERE id = ?').get(bot.id) as unknown as BotRow;
        await answerCb(token, cb.id, 'Setting updated.');
        await this.sendChildSettingsMenu(fresh, chatId, msgId);
      }
      return;
    }

    if (data === 'ca_broadcast') {
      await answerCb(token, cb.id);
      this.db.prepare("UPDATE child_users SET state = 'ca_bc_msg' WHERE id = ?").run(user.id);
      await sendMsg(
        token,
        chatId,
        `📣 <b>Broadcast to Your Bot Users</b>\n\nSend message to deliver to all users of @${esc(bot.bot_username)} (HTML supported):`
      );
      return;
    }

    if (data === 'ca_bc_exec') {
      let sd: { msg?: string; btn?: { text: string; url: string } | null } = {};
      try {
        sd = JSON.parse(user.state_data || '{}');
      } catch {
        sd = {};
      }
      if (!sd.msg) {
        await answerCb(token, cb.id, 'No pending broadcast.', true);
        return;
      }
      await answerCb(token, cb.id, 'Broadcasting...');
      this.db.prepare("UPDATE child_users SET state_data = '' WHERE id = ?").run(user.id);
      const markup = sd.btn ? { inline_keyboard: [[sd.btn]] } : undefined;
      await editMsg(token, chatId, msgId, '⏳ <b>Broadcasting to your bot users...</b>');
      const uids = (
        this.db.prepare('SELECT user_id FROM child_users WHERE bot_db_id = ? AND is_banned = 0').all(bot.id) as Array<{
          user_id: number;
        }>
      ).map((r) => r.user_id);
      const res = await executeBroadcast(token, uids, sd.msg, markup);
      await sendMsg(token, chatId, `✅ <b>Broadcast Complete</b>\n\n📤 Sent: <code>${res.sent}</code>\n❌ Failed: <code>${res.failed}</code>`);
    }
  }

  private tokenFor(bot: BotRow): string {
    return bot.token;
  }

  private async sendChildAdminMenu(bot: BotRow, chatId: number, editMsgId?: number): Promise<void> {
    const pend = Number(
      (this.db.prepare("SELECT COUNT(*) AS c FROM withdrawals WHERE bot_db_id = ? AND status = 'pending'").get(bot.id) as { c: number }).c
    );
    const pendDeps = Number(
      (this.db.prepare("SELECT COUNT(*) AS c FROM child_deposits WHERE bot_db_id = ? AND status = 'pending'").get(bot.id) as { c: number }).c
    );
    const pendSells = Number(
      (this.db.prepare("SELECT COUNT(*) AS c FROM gmail_sell_requests WHERE bot_db_id = ? AND status = 'pending'").get(bot.id) as { c: number }).c
    );
    const users = Number((this.db.prepare('SELECT COUNT(*) AS c FROM child_users WHERE bot_db_id = ?').get(bot.id) as { c: number }).c);
    const curr = bot.currency;
    const isRedeem = isRedeemBotType(bot.bot_type);
    const isStar = isStarBotType(bot.bot_type);
    const isGmail = isGmailBotType(bot.bot_type);
    const isAdv = isAdvancedBotType(bot.bot_type);

    const txt =
      `👑 <b>Child Bot Admin Panel</b>\n` +
      `🤖 @${esc(bot.bot_username)} · <i>${botTypeLabel(bot.bot_type)}</i>\n\n` +
      `<blockquote>` +
      `👥 Users: <code>${users}</code>` +
      (!isRedeem ? ` · ⏳ Pending WD: <code>${pend}</code>` : '') +
      (isGmail ? ` · 💳 Dep: <code>${pendDeps}</code> · 📤 Sell: <code>${pendSells}</code>` : '') +
      `\n🎁 Daily Bonus: <code>${esc(fmtAmount(curr, bot.daily_bonus))}</code> · 👥 Per Refer: <code>${esc(fmtAmount(curr, bot.per_refer))}</code> · ${isStar ? '🌟' : '🏦'} Min WD: <code>${esc(fmtAmount(curr, bot.min_withdraw))}</code>` +
      `</blockquote>`;

    const kbRows: Array<Array<{ text: string; callback_data: string; style?: TgButtonStyle }>> = [];
    if (isGmail) {
      kbRows.push([
        { text: '📧 Gmail Stock & Plans', callback_data: 'ca_gplans', style: 'success' },
        { text: `📤 Sell Requests (${pendSells})`, callback_data: 'ca_gsells:0', style: 'primary' },
      ]);
      kbRows.push([
        { text: `💳 Deposits & QR (${pendDeps})`, callback_data: 'ca_deposit', style: 'success' },
        { text: `💸 Withdrawals (${pend})`, callback_data: 'ca_wds:0', style: 'primary' },
      ]);
      kbRows.push([
        { text: '📊 Bot Status', callback_data: 'ca_stats', style: 'primary' },
        { text: '👮 Manage Admins', callback_data: 'ca_admins', style: 'primary' },
      ]);
    } else if (isRedeem) {
      kbRows.push([
        { text: '🎟 Redeem Plans & Stock', callback_data: 'ca_plans', style: 'success' },
        { text: '📊 Bot Status', callback_data: 'ca_stats', style: 'primary' },
      ]);
    } else {
      kbRows.push([
        { text: `${isStar ? '🌟 Star Withdrawals' : '💸 Withdrawals'} (${pend})`, callback_data: 'ca_wds:0', style: 'success' },
        { text: '📊 Bot Status', callback_data: 'ca_stats', style: 'primary' },
      ]);
    }
    if (isAdv) {
      kbRows.push([
        { text: '📋 Manage Tasks', callback_data: 'ca_tasks', style: 'primary' },
        { text: '🎫 Gift Codes', callback_data: 'ca_promos', style: 'success' },
      ]);
    }
    kbRows.push([
      { text: '📋 Users List', callback_data: 'ca_users:0', style: 'primary' },
      { text: '🔍 Find User', callback_data: 'ca_find_user', style: 'primary' },
    ]);
    if (!isGmail) {
      kbRows.push([{ text: '👮 Manage Admins', callback_data: 'ca_admins', style: 'primary' }]);
    }
    kbRows.push([
      { text: '📢 Force Channels', callback_data: 'ca_channels:0', style: 'primary' },
      { text: '📣 Broadcast', callback_data: 'ca_broadcast', style: 'success' },
    ]);
    kbRows.push([{ text: '⚙️ Rewards & Bot Settings', callback_data: 'ca_settings', style: 'primary' }]);

    if (editMsgId) await editMsg(bot.token, chatId, editMsgId, txt, { inline_keyboard: kbRows });
    else await sendMsg(bot.token, chatId, txt, { inline_keyboard: kbRows });
  }

  private async sendGmailPlansAdminMenu(bot: BotRow, chatId: number, editMsgId?: number): Promise<void> {
    const plans = this.db
      .prepare(
        `SELECT gp.*, (SELECT COUNT(*) FROM gmail_stock gs WHERE gs.plan_id = gp.id AND gs.is_sold = 0) AS stock_count
         FROM gmail_plans gp WHERE gp.bot_db_id = ? ORDER BY gp.price ASC`
      )
      .all(bot.id) as unknown as GmailPlanRow[];
    const rows: Array<Array<{ text: string; callback_data: string; style?: TgButtonStyle }>> = plans.map((p) => [
      {
        text: `📧 ${p.title} (${bot.currency}${fmtNum(p.price)}) · Stock: ${p.stock_count ?? 0}`,
        callback_data: `ca_gplan_v:${p.id}`,
        style: (p.stock_count ?? 0) > 0 ? 'primary' : 'danger',
      },
    ]);
    rows.push([{ text: '➕ Create Gmail Plan', callback_data: 'ca_gplan_add', style: 'success' }]);
    rows.push([{ text: '⬅️ Admin Menu', callback_data: 'ca_home', style: 'primary' }]);
    const txt = `📧 <b>Gmail Plans &amp; Stock (${plans.length})</b>\n\nTap any plan to add Gmail accounts to stock:`;
    if (editMsgId) await editMsg(bot.token, chatId, editMsgId, txt, { inline_keyboard: rows });
    else await sendMsg(bot.token, chatId, txt, { inline_keyboard: rows });
  }

  private async sendChildDepositAdminMenu(bot: BotRow, chatId: number, editMsgId?: number): Promise<void> {
    const enabledOn = bot.deposit_enabled === 1;
    const enabled = enabledOn ? '🟢 ON' : '🔴 OFF';
    const hasQr = bot.deposit_qr_file_id ? '✅ Set' : '❌ Not Set';
    const upi = bot.deposit_upi_id || 'Not Set';
    const pend = Number(
      (this.db.prepare("SELECT COUNT(*) AS c FROM child_deposits WHERE bot_db_id = ? AND status = 'pending'").get(bot.id) as { c: number }).c
    );
    const txt =
      `💳 <b>Bot Deposit &amp; QR Settings</b>\n\n` +
      `<blockquote>Status: <b>${enabled}</b>\n` +
      `📉 Min Deposit: <code>${esc(fmtAmount(bot.currency, bot.min_deposit || 10))}</code>\n` +
      `🖼 Deposit QR Photo: <b>${hasQr}</b>\n` +
      `🏦 Deposit UPI ID: <code>${esc(upi)}</code>\n` +
      `⏳ Pending Deposits: <code>${pend}</code></blockquote>`;
    const kb = {
      inline_keyboard: [
        [{ text: `⏳ Pending Deposits (${pend})`, callback_data: 'ca_deps:0', style: 'success' as TgButtonStyle }],
        [
          { text: '🖼 Set Deposit QR', callback_data: 'ca_dep_qr', style: 'primary' as TgButtonStyle },
          { text: '🏦 Set UPI ID', callback_data: 'ca_dep_upi', style: 'primary' as TgButtonStyle },
        ],
        [
          { text: `📉 Min (₹${fmtNum(bot.min_deposit || 10)})`, callback_data: 'ca_dep_min', style: 'primary' as TgButtonStyle },
          { text: `🔌 Deposits: ${enabled}`, callback_data: 'ca_dep_tog', style: (enabledOn ? 'success' : 'danger') as TgButtonStyle },
        ],
        [{ text: '⬅️ Admin Menu', callback_data: 'ca_home', style: 'primary' as TgButtonStyle }],
      ],
    };
    if (editMsgId) await editMsg(bot.token, chatId, editMsgId, txt, kb);
    else await sendMsg(bot.token, chatId, txt, kb);
  }

  private async sendChildAdminsMenu(bot: BotRow, chatId: number, editMsgId?: number): Promise<void> {
    const added = this.db
      .prepare('SELECT user_id FROM child_admins WHERE bot_db_id = ? ORDER BY added_at ASC')
      .all(bot.id) as unknown as Array<{ user_id: number }>;
    const txt = `👮 <b>Child Bot Admins</b>\n\n<blockquote>👑 Owner: <code>${bot.owner_id}</code>\n👮 Added Admins: <code>${added.length}</code></blockquote>`;
    const rows: Array<Array<{ text: string; callback_data: string; style?: TgButtonStyle }>> = added.map((a) => [
      { text: `👮 Admin ${a.user_id}`, callback_data: `ca_u_view:${a.user_id}`, style: 'primary' },
      { text: '🗑 Remove', callback_data: `ca_admin_del:${a.user_id}`, style: 'danger' },
    ]);
    rows.push([{ text: '➕ Add Admin', callback_data: 'ca_admin_add', style: 'success' }]);
    rows.push([{ text: '⬅️ Admin Menu', callback_data: 'ca_home', style: 'primary' }]);
    if (editMsgId) await editMsg(bot.token, chatId, editMsgId, txt, { inline_keyboard: rows });
    else await sendMsg(bot.token, chatId, txt, { inline_keyboard: rows });
  }

  private async sendChildPlansMenu(bot: BotRow, chatId: number, editMsgId?: number): Promise<void> {
    const plans = this.db
      .prepare(
        `SELECT rp.*, (SELECT COUNT(*) FROM redeem_codes rc WHERE rc.plan_id = rp.id AND rc.is_used = 0) AS stock_count
         FROM redeem_plans rp WHERE rp.bot_db_id = ? ORDER BY rp.cost ASC`
      )
      .all(bot.id) as unknown as RedeemPlanRow[];
    const rows: Array<Array<{ text: string; callback_data: string; style?: TgButtonStyle }>> = plans.map((p) => [
      {
        text: `🎟 ${p.title} (${bot.currency}${fmtNum(p.cost)}) · Stock: ${p.stock_count ?? 0}`,
        callback_data: `ca_plan_v:${p.id}`,
        style: (p.stock_count ?? 0) > 0 ? 'primary' : 'danger',
      },
    ]);
    rows.push([{ text: '➕ Create Redeem Plan', callback_data: 'ca_plan_add', style: 'success' }]);
    rows.push([{ text: '⬅️ Admin Menu', callback_data: 'ca_home', style: 'primary' }]);
    const txt = `🎟 <b>Redeem Plans &amp; Code Stock (${plans.length})</b>\nTap a plan to add codes:`;
    if (editMsgId) await editMsg(bot.token, chatId, editMsgId, txt, { inline_keyboard: rows });
    else await sendMsg(bot.token, chatId, txt, { inline_keyboard: rows });
  }

  private async sendChildTasksAdminMenu(bot: BotRow, chatId: number, editMsgId?: number): Promise<void> {
    const tasks = this.db
      .prepare('SELECT * FROM child_tasks WHERE bot_db_id = ? ORDER BY id DESC')
      .all(bot.id) as unknown as ChildTaskRow[];
    const rows: Array<Array<{ text: string; callback_data: string; style?: TgButtonStyle }>> = tasks.map((t) => [
      { text: `📋 ${t.title} (+${fmtAmount(bot.currency, t.reward)})`, callback_data: `ca_task_del:${t.id}`, style: 'primary' },
      { text: '🗑 Delete', callback_data: `ca_task_del:${t.id}`, style: 'danger' },
    ]);
    rows.push([{ text: '➕ Add Task', callback_data: 'ca_task_add', style: 'success' }]);
    rows.push([{ text: '⬅️ Admin Menu', callback_data: 'ca_home', style: 'primary' }]);
    const txt = `📋 <b>Tasks (${tasks.length})</b>`;
    if (editMsgId) await editMsg(bot.token, chatId, editMsgId, txt, { inline_keyboard: rows });
    else await sendMsg(bot.token, chatId, txt, { inline_keyboard: rows });
  }

  private async sendChildPromosAdminMenu(bot: BotRow, chatId: number, editMsgId?: number): Promise<void> {
    const promos = this.db
      .prepare('SELECT * FROM child_promos WHERE bot_db_id = ? ORDER BY id DESC')
      .all(bot.id) as unknown as ChildPromoRow[];
    const rows: Array<Array<{ text: string; callback_data: string; style?: TgButtonStyle }>> = promos.map((p) => [
      { text: `🎫 ${p.code} (+${fmtAmount(bot.currency, p.reward)} · ${p.used_count}/${p.max_uses})`, callback_data: `ca_promo_del:${p.id}`, style: 'primary' },
      { text: '🗑 Delete', callback_data: `ca_promo_del:${p.id}`, style: 'danger' },
    ]);
    rows.push([{ text: '➕ Create Gift Code', callback_data: 'ca_promo_add', style: 'success' }]);
    rows.push([{ text: '⬅️ Admin Menu', callback_data: 'ca_home', style: 'primary' }]);
    const txt = `🎫 <b>Gift / Promo Codes (${promos.length})</b>`;
    if (editMsgId) await editMsg(bot.token, chatId, editMsgId, txt, { inline_keyboard: rows });
    else await sendMsg(bot.token, chatId, txt, { inline_keyboard: rows });
  }

  private async sendChildAdminUserCard(
    bot: BotRow,
    chatId: number,
    targetId: number,
    sendNew = false,
    editMsgId?: number
  ): Promise<void> {
    const u = this.db
      .prepare('SELECT * FROM child_users WHERE bot_db_id = ? AND user_id = ?')
      .get(bot.id, targetId) as unknown as ChildUserRow | undefined;
    if (!u) return;
    const curr = bot.currency;
    const isStar = isStarBotType(bot.bot_type);
    const st = u.is_banned === 1 ? '🚫 Banned' : '🟢 Active';
    const banLbl = u.is_banned === 1 ? '✅ Unban' : '🚫 Ban';
    const txt =
      `👤 <b>Bot User</b>\n\n` +
      `<blockquote>` +
      `ID: <code>${u.user_id}</code>\n` +
      `Name: <b>${esc(u.first_name)}</b>\n` +
      `Balance: <code>${esc(fmtAmount(curr, u.balance))}</code>\n` +
      `${isStar ? 'Star Target' : 'UPI ID'}: <code>${esc(u.upi_id || 'None')}</code>\n` +
      `📱 Device: ${u.device_verified === 1 ? '✅ Verified' : 'Unverified'}\n` +
      `Referrals: <code>${u.total_refs}</code>\n` +
      `Status: <b>${st}</b>` +
      `</blockquote>`;
    const kb = {
      inline_keyboard: [
        [
          { text: '➕ Add Balance', callback_data: `ca_u_add:${targetId}`, style: 'success' },
          { text: '➖ Deduct Balance', callback_data: `ca_u_sub:${targetId}`, style: 'danger' },
        ],
        [
          { text: banLbl, callback_data: `ca_u_ban:${targetId}`, style: u.is_banned === 1 ? 'success' : 'danger' },
          { text: '⬅️ Admin Menu', callback_data: 'ca_home', style: 'primary' },
        ],
      ],
    };
    if (editMsgId && !sendNew) await editMsg(bot.token, chatId, editMsgId, txt, kb);
    else await sendMsg(bot.token, chatId, txt, kb);
  }

  private async sendChildChannelsMenu(bot: BotRow, chatId: number, page = 0, editMsgId?: number): Promise<void> {
    const total = Number(
      (this.db.prepare('SELECT COUNT(*) AS c FROM child_channels WHERE bot_db_id = ?').get(bot.id) as { c: number }).c
    );
    const limit = 8;
    const offset = Math.max(0, page) * limit;
    const chs = this.db
      .prepare('SELECT * FROM child_channels WHERE bot_db_id = ? ORDER BY id ASC LIMIT ? OFFSET ?')
      .all(bot.id, limit, offset) as unknown as ChannelRow[];
    const txt = `📢 <b>Bot Force Join Channels (${total} total)</b>\n\nAdd as many channels as you want:`;
    const rows: Array<Array<{ text: string; url?: string; callback_data?: string; style?: TgButtonStyle }>> = chs.map((c) => [
      { text: `📢 ${c.title}`, url: c.invite_link, style: 'primary' },
      { text: '🗑 Remove', callback_data: `ca_ch_del:${c.id}`, style: 'danger' },
    ]);
    const nav: Array<{ text: string; callback_data: string; style?: TgButtonStyle }> = [];
    if (page > 0) nav.push({ text: '⬅️ Prev', callback_data: `ca_channels:${page - 1}`, style: 'primary' });
    if (offset + chs.length < total) nav.push({ text: 'Next ➡️', callback_data: `ca_channels:${page + 1}`, style: 'primary' });
    if (nav.length > 0) rows.push(nav);
    rows.push([{ text: '➕ Add Force Channel(s)', callback_data: 'ca_ch_add', style: 'success' }]);
    rows.push([{ text: '⬅️ Admin Menu', callback_data: 'ca_home', style: 'primary' }]);
    if (editMsgId) await editMsg(bot.token, chatId, editMsgId, txt, { inline_keyboard: rows });
    else await sendMsg(bot.token, chatId, txt, { inline_keyboard: rows });
  }

  private async sendChildSettingsMenu(bot: BotRow, chatId: number, editMsgId?: number): Promise<void> {
    const curr = bot.currency;
    const isStar = isStarBotType(bot.bot_type);
    const isGmail = isGmailBotType(bot.bot_type);
    const wdOpenFlag = bot.withdrawals_open === 1;
    const maintFlag = bot.maintenance === 1;
    const devFlag = bot.device_verify === 1;
    const sellOpenFlag = bot.gmail_sell_open === 1;
    const wdOpen = wdOpenFlag ? '🟢 Open' : '🔴 Closed';
    const maint = maintFlag ? '🔴 ON' : '🟢 OFF';
    const dev = devFlag ? '🟢 ON' : '🔴 OFF';
    const sellOpen = sellOpenFlag ? '🟢 Open' : '🔴 Closed';
    const txt =
      `⚙️ <b>Rewards &amp; Bot Settings (${isStar ? 'Telegram Stars' : 'INR'})</b>\n\n` +
      `<blockquote>` +
      `🎁 Daily Bonus: <code>${esc(fmtAmount(curr, bot.daily_bonus))}</code>\n` +
      `👥 Per Refer: <code>${esc(fmtAmount(curr, bot.per_refer))}</code>\n` +
      `${isStar ? '🌟' : '🏦'} Min Withdraw: <code>${esc(fmtAmount(curr, bot.min_withdraw))}</code>\n` +
      (isGmail
        ? `📤 Gmail Buy-Back Rate: <code>${esc(fmtAmount(curr, bot.gmail_sell_price))}</code> · Sell: <b>${sellOpen}</b>\n`
        : '') +
      `📱 Device Verification: <b>${dev}</b>\n` +
      `🆘 Support: ${esc(bot.support_username || 'Not Set')}\n` +
      `💸 Withdrawals: <b>${wdOpen}</b> · 🛠 Maint: <b>${maint}</b>` +
      `</blockquote>`;
    const rows: Array<Array<{ text: string; callback_data: string; style?: TgButtonStyle }>> = [
      [
        { text: `👥 Per Refer (${fmtAmount(curr, bot.per_refer)})`, callback_data: 'ca_set:per_refer', style: 'primary' },
        { text: `${isStar ? '🌟' : '🏦'} Min WD (${fmtAmount(curr, bot.min_withdraw)})`, callback_data: 'ca_set:min_withdraw', style: 'primary' },
      ],
      [
        { text: `🎁 Daily Bonus (${fmtAmount(curr, bot.daily_bonus)})`, callback_data: 'ca_set:daily_bonus', style: 'success' },
        { text: '🆘 Support @', callback_data: 'ca_set:support_username', style: 'primary' },
      ],
    ];
    if (isGmail) {
      rows.push([
        { text: `📤 Gmail Sell Rate (${fmtAmount(curr, bot.gmail_sell_price)})`, callback_data: 'ca_set:gmail_sell_price', style: 'primary' },
        { text: `📤 Sell Gmail: ${sellOpen}`, callback_data: 'ca_tog:gmail_sell_open', style: sellOpenFlag ? 'success' : 'danger' },
      ]);
    }
    rows.push([
      { text: `📱 Device Verify: ${dev}`, callback_data: 'ca_tog:device_verify', style: devFlag ? 'success' : 'danger' },
      { text: `💸 Withdraw: ${wdOpen}`, callback_data: 'ca_tog:withdrawals_open', style: wdOpenFlag ? 'success' : 'danger' },
    ]);
    rows.push([{ text: `🛠 Maint: ${maint}`, callback_data: 'ca_tog:maintenance', style: maintFlag ? 'danger' : 'success' }]);
    rows.push([{ text: '⬅️ Admin Menu', callback_data: 'ca_home', style: 'primary' }]);
    const kb = { inline_keyboard: rows };
    if (editMsgId) await editMsg(bot.token, chatId, editMsgId, txt, kb);
    else await sendMsg(bot.token, chatId, txt, kb);
  }
}
