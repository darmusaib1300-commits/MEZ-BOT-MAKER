import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { BotManager } from './server/botEngine.ts';
import { renderDeviceVerifyHtml } from './server/verifyPage.ts';

const PORT = Number(process.env.PORT || 3000);
const MASTER_BOT_TOKEN = (process.env.MASTER_BOT_TOKEN || '').trim();
const MASTER_ADMIN_IDS = (process.env.MASTER_ADMIN_IDS || '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

const botManager = new BotManager({
  masterToken: MASTER_BOT_TOKEN,
  masterAdminIds: MASTER_ADMIN_IDS,
  verifyBaseUrl: process.env.APP_URL || '',
  defaultDailyCoins: Number(process.env.DEFAULT_DAILY_COINS || 2),
  defaultBotCost: Number(process.env.DEFAULT_BOT_COST || 5),
  defaultMasterRefCoins: Number(process.env.DEFAULT_MASTER_REF_COINS || 1),
});

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json());

  app.get('/api/status', (_req, res) => {
    res.json(botManager.getStatus());
  });

  app.post('/api/settings', (req, res) => {
    const body = (req.body || {}) as {
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
    };
    botManager.updateMasterSettingsFromApi(body);
    res.json({ ok: true, status: botManager.getStatus() });
  });

  app.post('/api/bot/restart', async (_req, res) => {
    await botManager.restart();
    res.json({ ok: true, status: botManager.getStatus() });
  });

  app.get('/verify', (req, res) => {
    const token = String(req.query.token || '').trim();
    if (!token) {
      res
        .status(400)
        .type('html')
        .send(
          '<!doctype html><html><body style="font-family:system-ui,sans-serif;padding:40px;text-align:center;"><h2>Invalid Verification Link</h2><p>Missing token parameter. Please request a fresh verification link inside Telegram.</p></body></html>'
        );
      return;
    }
    const info = botManager.getDeviceTokenInfo(token);
    if (!info.valid) {
      res
        .status(400)
        .type('html')
        .send(
          '<!doctype html><html><body style="font-family:system-ui,sans-serif;padding:40px;text-align:center;"><h2>Verification Link Expired</h2><p>This verification link has expired or was already used. Return to Telegram and send /start to get a new link.</p></body></html>'
        );
      return;
    }
    res.type('html').send(renderDeviceVerifyHtml(token, info.botLabel));
  });

  app.post('/api/verify-device', async (req, res) => {
    const body = (req.body || {}) as { token?: string; deviceHash?: string };
    const token = String(body.token || '').trim();
    const deviceHash = String(body.deviceHash || '').trim();
    const forwarded = String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim();
    const ip = forwarded || req.socket.remoteAddress || '';
    const result = await botManager.verifyDeviceByToken(token, deviceHash, ip);
    res.status(result.status).json({
      ok: result.ok,
      message: result.message,
      error: result.error,
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build not found.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Listening on http://0.0.0.0:${PORT}`);
    void botManager.start();
  });

  const shutdown = () => {
    botManager.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void startServer();
