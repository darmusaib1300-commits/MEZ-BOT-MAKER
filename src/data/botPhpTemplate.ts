import rawBotPhp from '../../bot.php?raw';

export interface BotConfig {
  masterBotToken: string;
  masterAdminIds: string;
  webhookBaseUrl: string;
  setupSecret: string;
  defaultDailyCoins: number;
  defaultBotCost: number;
  defaultMasterRefCoins: number;
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  masterBotToken: 'YOUR_MASTER_BOT_TOKEN_HERE',
  masterAdminIds: '123456789',
  webhookBaseUrl: 'https://yourdomain.com/bot.php',
  setupSecret: 'telefactory_secret_2026',
  defaultDailyCoins: 2,
  defaultBotCost: 5,
  defaultMasterRefCoins: 1,
};

export function generateBotPhp(config: BotConfig): string {
  const adminIdsArray =
    config.masterAdminIds
      .split(',')
      .map((id) => id.trim().replace(/[^0-9]/g, ''))
      .filter((id) => id.length > 0)
      .join(', ') || '123456789';

  const safeToken = config.masterBotToken.replace(/'/g, "\\'");
  const safeBaseUrl = config.webhookBaseUrl.trim().replace(/\/+$/, '').replace(/'/g, "\\'");
  const safeSecret = config.setupSecret.replace(/'/g, "\\'");
  const dailyCoins = Math.max(0, Math.floor(Number(config.defaultDailyCoins) || 0));
  const botCost = Math.max(1, Math.floor(Number(config.defaultBotCost) || 5));
  const refCoins = Math.max(0, Math.floor(Number(config.defaultMasterRefCoins) || 0));

  return rawBotPhp
    .replace(
      "define('MASTER_BOT_TOKEN', 'YOUR_MASTER_BOT_TOKEN_HERE');",
      `define('MASTER_BOT_TOKEN', '${safeToken}');`
    )
    .replace(
      "define('MASTER_ADMIN_IDS', [123456789]);",
      `define('MASTER_ADMIN_IDS', [${adminIdsArray}]);`
    )
    .replace(
      "define('WEBHOOK_BASE_URL', 'https://yourdomain.com/bot.php');",
      `define('WEBHOOK_BASE_URL', '${safeBaseUrl}');`
    )
    .replace(
      "define('SETUP_SECRET', 'telefactory_secret_2026');",
      `define('SETUP_SECRET', '${safeSecret}');`
    )
    .replace(
      "https://yourdomain.com/bot.php?setup=1&key=telefactory_secret_2026",
      `${safeBaseUrl || 'https://yourdomain.com/bot.php'}?setup=1&key=${safeSecret}`
    )
    .replace(
      "define('DEFAULT_DAILY_COINS', 2);",
      `define('DEFAULT_DAILY_COINS', ${dailyCoins});`
    )
    .replace(
      "define('DEFAULT_BOT_COST', 5);",
      `define('DEFAULT_BOT_COST', ${botCost});`
    )
    .replace(
      "define('DEFAULT_MASTER_REF_COINS', 1);",
      `define('DEFAULT_MASTER_REF_COINS', ${refCoins});`
    );
}
