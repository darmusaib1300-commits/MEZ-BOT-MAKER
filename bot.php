<?php
/**
 * TeleFactory PHP - Single-File Master Bot Maker & UPI Refer-and-Earn Child Bot Engine
 *
 * Features:
 * 1. Master Bot (Bot Maker): Daily Coins, Refer & Earn Coins, Force Join Channels,
 *    Create Child Bot (default 5 coins = 1 bot), My Bots manager.
 * 2. Master Admin Panel (/admin): User Status & Lookup, Ban/Unban, Add/Deduct Coins,
 *    Force Channels, Set Daily Coins & Bot Cost, Broadcast to Master Users OR All Child Bots,
 *    Manage All Child Bots. (Zero withdrawal system in Master Admin).
 * 3. Child Bot (UPI Refer & Earn): Force Join Check, Verified Referral Crediting,
 *    Daily Bonus, Save UPI ID, Withdraw Request, Withdrawal History.
 * 4. Child Bot Admin Panel (/admin inside child bot): Bot Status & User Lookup,
 *    Withdrawal Queue (Approve/Reject + Refund), Force Channels, Broadcast,
 *    Settings (Per-Refer Reward, Min Withdraw, Daily Bonus, Currency, Maintenance).
 *
 * Setup:
 * 1. Upload this file as bot.php to an HTTPS PHP 8.0+ server with curl & pdo_sqlite enabled.
 * 2. Open: https://yourdomain.com/bot.php?setup=1&key=telefactory_secret_2026
 */

declare(strict_types=1);
@set_time_limit(0);
@ignore_user_abort(true);

// ============================================================================
// 1. CONFIGURATION
// ============================================================================
define('MASTER_BOT_TOKEN', 'YOUR_MASTER_BOT_TOKEN_HERE');
define('MASTER_ADMIN_IDS', [123456789]);
define('WEBHOOK_BASE_URL', 'https://yourdomain.com/bot.php');
define('SETUP_SECRET', 'telefactory_secret_2026');
define('DB_FILE', __DIR__ . '/bot_factory_data.sqlite');

define('DEFAULT_DAILY_COINS', 2);
define('DEFAULT_BOT_COST', 5);
define('DEFAULT_MASTER_REF_COINS', 1);

// ============================================================================
// 2. DATABASE INITIALIZATION (SQLite PDO)
// ============================================================================
function getDb(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $isNew = !file_exists(DB_FILE);
    $pdo = new PDO('sqlite:' . DB_FILE, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_TIMEOUT => 10,
    ]);

    $pdo->exec('PRAGMA journal_mode = WAL;');
    $pdo->exec('PRAGMA synchronous = NORMAL;');
    $pdo->exec('PRAGMA foreign_keys = ON;');
    $pdo->exec('PRAGMA busy_timeout = 5000;');

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS master_users (
            user_id INTEGER PRIMARY KEY,
            username TEXT DEFAULT '',
            first_name TEXT DEFAULT '',
            coins INTEGER NOT NULL DEFAULT 0,
            referred_by INTEGER NOT NULL DEFAULT 0,
            ref_credited INTEGER NOT NULL DEFAULT 0,
            total_refs INTEGER NOT NULL DEFAULT 0,
            last_daily_at INTEGER NOT NULL DEFAULT 0,
            is_banned INTEGER NOT NULL DEFAULT 0,
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

        CREATE TABLE IF NOT EXISTS bots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_id INTEGER NOT NULL,
            token TEXT NOT NULL UNIQUE,
            bot_id_tg INTEGER NOT NULL DEFAULT 0,
            bot_username TEXT NOT NULL DEFAULT '',
            bot_name TEXT NOT NULL DEFAULT '',
            is_active INTEGER NOT NULL DEFAULT 1,
            per_refer REAL NOT NULL DEFAULT 10.0,
            min_withdraw REAL NOT NULL DEFAULT 50.0,
            daily_bonus REAL NOT NULL DEFAULT 5.0,
            currency TEXT NOT NULL DEFAULT '₹',
            withdrawals_open INTEGER NOT NULL DEFAULT 1,
            maintenance INTEGER NOT NULL DEFAULT 0,
            support_username TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL DEFAULT 0
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

        CREATE INDEX IF NOT EXISTS idx_child_users_bot ON child_users(bot_db_id, user_id);
        CREATE INDEX IF NOT EXISTS idx_withdrawals_bot_status ON withdrawals(bot_db_id, status);
        CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_id);
    ");

    $defaults = [
        'daily_coins' => (string)DEFAULT_DAILY_COINS,
        'bot_cost' => (string)DEFAULT_BOT_COST,
        'master_ref_coins' => (string)DEFAULT_MASTER_REF_COINS,
        'maintenance' => '0',
        'support_username' => '@Support',
        'master_bot_username' => '',
    ];
    $stmt = $pdo->prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
    foreach ($defaults as $k => $v) {
        $stmt->execute([$k, $v]);
    }

    if ($isNew) {
        @chmod(DB_FILE, 0600);
    }

    $htaccess = __DIR__ . '/.htaccess';
    if (!file_exists($htaccess) && is_writable(__DIR__)) {
        @file_put_contents($htaccess, "<FilesMatch \"\\.(sqlite|sqlite3|db)$\">\n  Require all denied\n</FilesMatch>\n");
    }

    return $pdo;
}

function getSetting(PDO $pdo, string $key, string $default = ''): string
{
    $stmt = $pdo->prepare("SELECT value FROM settings WHERE key = ?");
    $stmt->execute([$key]);
    $val = $stmt->fetchColumn();
    return $val === false ? $default : (string)$val;
}

function setSetting(PDO $pdo, string $key, string $value): void
{
    $stmt = $pdo->prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    $stmt->execute([$key, $value]);
}

function getWebhookBaseUrl(): string
{
    if (WEBHOOK_BASE_URL !== '' && strpos(WEBHOOK_BASE_URL, 'yourdomain.com') === false) {
        return rtrim(WEBHOOK_BASE_URL, '/');
    }
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $script = $_SERVER['SCRIPT_NAME'] ?? '/bot.php';
    return $scheme . '://' . $host . $script;
}

// ============================================================================
// 3. TELEGRAM BOT API HELPERS
// ============================================================================
function tgApi(string $token, string $method, array $params = []): array
{
    $url = 'https://api.telegram.org/bot' . $token . '/' . $method;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($params, JSON_UNESCAPED_UNICODE),
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 15,
    ]);
    $raw = curl_exec($ch);
    $err = curl_error($ch);
    curl_close($ch);

    if ($raw === false) {
        return ['ok' => false, 'description' => 'cURL error: ' . $err];
    }
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        return ['ok' => false, 'description' => 'Invalid JSON from Telegram'];
    }
    return $decoded;
}

function sendMsg(string $token, int|string $chatId, string $text, ?array $replyMarkup = null, bool $disablePreview = true): array
{
    $params = [
        'chat_id' => $chatId,
        'text' => $text,
        'parse_mode' => 'HTML',
        'disable_web_page_preview' => $disablePreview,
    ];
    if ($replyMarkup !== null) {
        $params['reply_markup'] = $replyMarkup;
    }
    return tgApi($token, 'sendMessage', $params);
}

function editMsg(string $token, int|string $chatId, int $messageId, string $text, ?array $replyMarkup = null, bool $disablePreview = true): array
{
    $params = [
        'chat_id' => $chatId,
        'message_id' => $messageId,
        'text' => $text,
        'parse_mode' => 'HTML',
        'disable_web_page_preview' => $disablePreview,
    ];
    if ($replyMarkup !== null) {
        $params['reply_markup'] = $replyMarkup;
    }
    return tgApi($token, 'editMessageText', $params);
}

function answerCb(string $token, string $cbId, string $text = '', bool $showAlert = false): void
{
    $params = ['callback_query_id' => $cbId];
    if ($text !== '') {
        $params['text'] = $text;
        $params['show_alert'] = $showAlert;
    }
    tgApi($token, 'answerCallbackQuery', $params);
}

function esc(?string $str): string
{
    return htmlspecialchars((string)$str, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function fmtNum(float $num): string
{
    if (abs($num - round($num)) < 0.00001) {
        return (string)(int)round($num);
    }
    return rtrim(rtrim(number_format($num, 2, '.', ''), '0'), '.');
}

function fmtDuration(int $seconds): string
{
    if ($seconds <= 0) {
        return 'now';
    }
    $h = intdiv($seconds, 3600);
    $m = intdiv($seconds % 3600, 60);
    $s = $seconds % 60;
    if ($h > 0) {
        return "{$h}h {$m}m";
    }
    if ($m > 0) {
        return "{$m}m {$s}s";
    }
    return "{$s}s";
}

function isMasterAdmin(int $userId): bool
{
    return in_array($userId, MASTER_ADMIN_IDS, true);
}

function checkForceJoin(string $token, array $channels, int $userId): array
{
    $unjoined = [];
    foreach ($channels as $ch) {
        $res = tgApi($token, 'getChatMember', [
            'chat_id' => $ch['chat_id'],
            'user_id' => $userId,
        ]);
        if (!($res['ok'] ?? false)) {
            continue;
        }
        $member = $res['result'] ?? [];
        $status = $member['status'] ?? 'left';
        $isMember = in_array($status, ['creator', 'administrator', 'member'], true)
            || ($status === 'restricted' && !empty($member['is_member']));
        if (!$isMember) {
            $unjoined[] = $ch;
        }
    }
    return $unjoined;
}

function buildForceJoinMarkup(array $channels, string $verifyCallback): array
{
    $rows = [];
    foreach ($channels as $idx => $ch) {
        $label = $ch['title'] !== '' ? $ch['title'] : ('Channel ' . ($idx + 1));
        $url = $ch['invite_link'];
        if ($url !== '') {
            $rows[] = [['text' => '📢 Join ' . $label, 'url' => $url]];
        }
    }
    $rows[] = [['text' => '✅ I Joined / Verify', 'callback_data' => $verifyCallback]];
    return ['inline_keyboard' => $rows];
}

function resolveChannelInput(string $token, string $rawInput): array
{
    $rawInput = trim($rawInput);
    $manualLink = '';
    if (strpos($rawInput, '|') !== false) {
        [$chatPart, $linkPart] = array_map('trim', explode('|', $rawInput, 2));
        $rawInput = $chatPart;
        $manualLink = $linkPart;
    }

    if (preg_match('/^https?:\/\/t\.me\/([A-Za-z0-9_]+)$/i', $rawInput, $m)) {
        $rawInput = '@' . $m[1];
    }

    $chatRes = tgApi($token, 'getChat', ['chat_id' => $rawInput]);
    if (!($chatRes['ok'] ?? false)) {
        return ['ok' => false, 'error' => $chatRes['description'] ?? 'Channel not found. Make sure the bot is an Admin in that channel.'];
    }
    $chat = $chatRes['result'];
    $chatId = (string)$chat['id'];
    $title = (string)($chat['title'] ?? $chat['username'] ?? $chatId);
    $username = $chat['username'] ?? '';

    $meRes = tgApi($token, 'getMe');
    if ($meRes['ok'] ?? false) {
        $botTgId = $meRes['result']['id'];
        $memRes = tgApi($token, 'getChatMember', ['chat_id' => $chatId, 'user_id' => $botTgId]);
        $botStatus = $memRes['result']['status'] ?? 'left';
        if (!in_array($botStatus, ['administrator', 'creator'], true)) {
            return ['ok' => false, 'error' => 'Please make this bot an Administrator in "' . esc($title) . '" first so it can verify members.'];
        }
    }

    $inviteLink = $manualLink;
    if ($inviteLink === '' && $username !== '') {
        $inviteLink = 'https://t.me/' . $username;
    }
    if ($inviteLink === '' && !empty($chat['invite_link'])) {
        $inviteLink = $chat['invite_link'];
    }
    if ($inviteLink === '') {
        $exp = tgApi($token, 'exportChatInviteLink', ['chat_id' => $chatId]);
        if ($exp['ok'] ?? false) {
            $inviteLink = (string)$exp['result'];
        }
    }

    if ($inviteLink === '') {
        return ['ok' => false, 'error' => 'Private channel detected without invite link. Send format: <code>-1001234567890 | https://t.me/+InviteLink</code>'];
    }

    return [
        'ok' => true,
        'chat_id' => $chatId,
        'title' => $title,
        'invite_link' => $inviteLink,
    ];
}

function executeBroadcast(string $token, array $userIds, string $text, ?array $inlineMarkup = null): array
{
    $sent = 0;
    $failed = 0;
    foreach ($userIds as $uid) {
        $res = sendMsg($token, $uid, $text, $inlineMarkup);
        if ($res['ok'] ?? false) {
            $sent++;
        } else {
            $errCode = (int)($res['error_code'] ?? 0);
            if ($errCode === 429) {
                $retry = (int)($res['parameters']['retry_after'] ?? 2);
                sleep(min($retry, 10));
                $retryRes = sendMsg($token, $uid, $text, $inlineMarkup);
                if ($retryRes['ok'] ?? false) {
                    $sent++;
                } else {
                    $failed++;
                }
            } else {
                $failed++;
            }
        }
        usleep(35000);
    }
    return ['sent' => $sent, 'failed' => $failed];
}

// ============================================================================
// 4. SETUP ENDPOINT (?setup=1&key=...)
// ============================================================================
if (isset($_GET['setup'])) {
    header('Content-Type: text/html; charset=utf-8');
    $key = (string)($_GET['key'] ?? '');
    if (SETUP_SECRET !== '' && !hash_equals(SETUP_SECRET, $key)) {
        http_response_code(403);
        echo '<h3>403 Forbidden - Invalid Setup Key</h3>';
        exit;
    }

    $pdo = getDb();
    $baseUrl = getWebhookBaseUrl();
    $masterWebhook = $baseUrl . '?bot_id=master';

    $me = tgApi(MASTER_BOT_TOKEN, 'getMe');
    $botUser = ($me['ok'] ?? false) ? ('@' . $me['result']['username']) : 'Invalid Token';
    if ($me['ok'] ?? false) {
        setSetting($pdo, 'master_bot_username', (string)$me['result']['username']);
    }

    $hookParams = [
        'url' => $masterWebhook,
        'drop_pending_updates' => true,
    ];
    if (SETUP_SECRET !== '') {
        $hookParams['secret_token'] = SETUP_SECRET;
    }
    $hook = tgApi(MASTER_BOT_TOKEN, 'setWebhook', $hookParams);

    $phpVer = PHP_VERSION;
    $hasCurl = function_exists('curl_init') ? 'Enabled' : 'MISSING';
    $hasSqlite = extension_loaded('pdo_sqlite') ? 'Enabled' : 'MISSING';
    $hookStatus = ($hook['ok'] ?? false) ? 'Active (' . htmlspecialchars($masterWebhook) . ')' : ('Failed: ' . htmlspecialchars($hook['description'] ?? 'Unknown'));

    echo "<!doctype html><html><head><meta charset='utf-8'><title>TeleFactory PHP Setup</title></head><body style='font-family:system-ui,sans-serif;max-width:680px;margin:40px auto;padding:24px;line-height:1.6;color:#0f172a;background:#f8fafc;'>";
    echo "<div style='background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;'>";
    echo "<h2 style='margin-top:0;'>TeleFactory PHP Setup Status</h2>";
    echo "<p><strong>PHP Version:</strong> {$phpVer}<br>";
    echo "<strong>cURL Extension:</strong> {$hasCurl}<br>";
    echo "<strong>PDO SQLite Extension:</strong> {$hasSqlite}<br>";
    echo "<strong>Master Bot:</strong> " . htmlspecialchars($botUser) . "<br>";
    echo "<strong>Master Webhook:</strong> {$hookStatus}</p>";
    echo "<p style='color:#475569;font-size:14px;'>Open your Master Bot on Telegram and send <code>/start</code> or <code>/admin</code>.</p>";
    echo "</div></body></html>";
    exit;
}

// ============================================================================
// 5. WEBHOOK DISPATCHER
// ============================================================================
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Content-Type: text/plain; charset=utf-8');
    echo 'TeleFactory PHP Bot Webhook Endpoint Ready.';
    exit;
}

if (SETUP_SECRET !== '') {
    $hdrSecret = $_SERVER['HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN'] ?? '';
    if (!hash_equals(SETUP_SECRET, $hdrSecret)) {
        http_response_code(403);
        exit('Invalid secret token');
    }
}

$rawInput = file_get_contents('php://input');
$update = json_decode((string)$rawInput, true);
if (!is_array($update)) {
    http_response_code(200);
    exit;
}

$pdo = getDb();
$botIdParam = (string)($_GET['bot_id'] ?? 'master');

if ($botIdParam === 'master') {
    handleMasterUpdate($pdo, $update);
} elseif (ctype_digit($botIdParam)) {
    $stmt = $pdo->prepare("SELECT * FROM bots WHERE id = ?");
    $stmt->execute([(int)$botIdParam]);
    $bot = $stmt->fetch();
    if ($bot) {
        handleChildUpdate($pdo, $bot, $update);
    }
}

http_response_code(200);
exit;

// ============================================================================
// 6. MASTER BOT ENGINE (BOT MAKER + MASTER ADMIN PANEL)
// ============================================================================
function masterMainKeyboard(int $userId): array
{
    $rows = [
        [['text' => '🎁 Daily Coins'], ['text' => '💰 My Balance']],
        [['text' => '🤖 Create Bot'], ['text' => '📱 My Bots']],
        [['text' => '👥 Refer & Earn'], ['text' => '🆘 Support']],
    ];
    if (isMasterAdmin($userId)) {
        $rows[] = [['text' => '🛡 Master Admin']];
    }
    return [
        'keyboard' => $rows,
        'resize_keyboard' => true,
        'is_persistent' => true,
    ];
}

function getMasterBotUsername(PDO $pdo): string
{
    $u = getSetting($pdo, 'master_bot_username', '');
    if ($u !== '') {
        return $u;
    }
    $me = tgApi(MASTER_BOT_TOKEN, 'getMe');
    if ($me['ok'] ?? false) {
        $u = (string)$me['result']['username'];
        setSetting($pdo, 'master_bot_username', $u);
        return $u;
    }
    return '';
}

function creditMasterReferralIfEligible(PDO $pdo, int $userId): void
{
    $refCoins = (int)getSetting($pdo, 'master_ref_coins', (string)DEFAULT_MASTER_REF_COINS);
    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare("SELECT referred_by, ref_credited, first_name FROM master_users WHERE user_id = ?");
        $stmt->execute([$userId]);
        $u = $stmt->fetch();
        if (!$u || (int)$u['referred_by'] <= 0 || (int)$u['ref_credited'] === 1) {
            $pdo->commit();
            return;
        }
        $refId = (int)$u['referred_by'];
        $upd = $pdo->prepare("UPDATE master_users SET ref_credited = 1 WHERE user_id = ? AND ref_credited = 0");
        $upd->execute([$userId]);
        if ($upd->rowCount() > 0) {
            $pdo->prepare("UPDATE master_users SET coins = coins + ?, total_refs = total_refs + 1 WHERE user_id = ?")
                ->execute([$refCoins, $refId]);
        }
        $pdo->commit();

        if ($refCoins > 0) {
            sendMsg(
                MASTER_BOT_TOKEN,
                $refId,
                "🎉 <b>New Verified Referral!</b>\n\n" .
                "👤 User: <b>" . esc($u['first_name']) . "</b> (<code>{$userId}</code>)\n" .
                "🪙 Earned: <b>+{$refCoins} Coins</b>"
            );
        }
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
    }
}

function handleMasterUpdate(PDO $pdo, array $update): void
{
    $token = MASTER_BOT_TOKEN;
    $msg = $update['message'] ?? null;
    $cb = $update['callback_query'] ?? null;

    if (!$msg && !$cb) {
        return;
    }

    $from = $cb ? $cb['from'] : $msg['from'];
    $chatId = $cb ? (int)$cb['message']['chat']['id'] : (int)$msg['chat']['id'];
    if ($chatId <= 0) {
        return;
    }

    $userId = (int)$from['id'];
    $username = (string)($from['username'] ?? '');
    $firstName = (string)($from['first_name'] ?? 'User');
    $text = trim((string)($msg['text'] ?? ''));
    $data = trim((string)($cb['data'] ?? ''));
    $now = time();

    $refCandidate = 0;
    if ($msg && preg_match('/^\/start(?:\s+(\d+))?/', $text, $m)) {
        if (!empty($m[1])) {
            $cand = (int)$m[1];
            if ($cand > 0 && $cand !== $userId) {
                $chk = $pdo->prepare("SELECT user_id FROM master_users WHERE user_id = ?");
                $chk->execute([$cand]);
                if ($chk->fetchColumn()) {
                    $refCandidate = $cand;
                }
            }
        }
    }

    $stmt = $pdo->prepare("SELECT * FROM master_users WHERE user_id = ?");
    $stmt->execute([$userId]);
    $user = $stmt->fetch();

    if (!$user) {
        $ins = $pdo->prepare("
            INSERT INTO master_users (user_id, username, first_name, coins, referred_by, joined_at, last_active_at)
            VALUES (?, ?, ?, 0, ?, ?, ?)
        ");
        $ins->execute([$userId, $username, $firstName, $refCandidate, $now, $now]);
        $stmt->execute([$userId]);
        $user = $stmt->fetch();
    } else {
        $pdo->prepare("UPDATE master_users SET username = ?, first_name = ?, last_active_at = ? WHERE user_id = ?")
            ->execute([$username, $firstName, $now, $userId]);
        $user['username'] = $username;
        $user['first_name'] = $firstName;
    }

    if ((int)$user['is_banned'] === 1 && !isMasterAdmin($userId)) {
        if ($cb) {
            answerCb($token, $cb['id'], 'Your account is banned.', true);
        } else {
            sendMsg($token, $chatId, "🚫 <b>Access Denied</b>\nYour account has been banned by the administrator.");
        }
        return;
    }

    if (getSetting($pdo, 'maintenance', '0') === '1' && !isMasterAdmin($userId)) {
        $mText = "🛠 <b>Bot Under Maintenance</b>\nPlease check back shortly.";
        if ($cb) {
            answerCb($token, $cb['id'], 'Bot is under maintenance.', true);
        } else {
            sendMsg($token, $chatId, $mText);
        }
        return;
    }

    if (!isMasterAdmin($userId)) {
        $channels = $pdo->query("SELECT * FROM master_channels ORDER BY id ASC")->fetchAll();
        if (!empty($channels)) {
            $unjoined = checkForceJoin($token, $channels, $userId);
            if (!empty($unjoined)) {
                if ($cb && $data === 'm_verify_join') {
                    answerCb($token, $cb['id'], 'Please join all required channels first!', true);
                    return;
                }
                if ($cb) {
                    answerCb($token, $cb['id']);
                }
                sendMsg(
                    $token,
                    $chatId,
                    "📢 <b>Join Required Channels</b>\n\nTo use this Bot Maker, join all channels below and tap <b>✅ I Joined / Verify</b>.",
                    buildForceJoinMarkup($unjoined, 'm_verify_join')
                );
                return;
            }
        }
    }

    if ((int)$user['referred_by'] > 0 && (int)$user['ref_credited'] === 0) {
        creditMasterReferralIfEligible($pdo, $userId);
    }

    if ($cb && $data === 'm_verify_join') {
        answerCb($token, $cb['id'], 'Verified! Welcome.');
        tgApi($token, 'deleteMessage', ['chat_id' => $chatId, 'message_id' => $cb['message']['message_id']]);
        sendMasterHome($pdo, $userId, $chatId);
        return;
    }

    if ($text === '❌ Cancel' || $text === '/cancel') {
        $pdo->prepare("UPDATE master_users SET state = '', state_data = '' WHERE user_id = ?")->execute([$userId]);
        sendMasterHome($pdo, $userId, $chatId, "Action cancelled.");
        return;
    }

    if ($cb) {
        handleMasterCallback($pdo, $user, $cb);
        return;
    }

    if (($text === '/admin' || $text === '🛡 Master Admin') && isMasterAdmin($userId)) {
        $pdo->prepare("UPDATE master_users SET state = '', state_data = '' WHERE user_id = ?")->execute([$userId]);
        sendMasterAdminMenu($pdo, $chatId);
        return;
    }

    $menuTriggers = ['/start', '/daily', '/balance', '/create', '/mybots', '/refer', '🎁 Daily Coins', '💰 My Balance', '🤖 Create Bot', '📱 My Bots', '👥 Refer & Earn', '🆘 Support'];
    $isMenuCmd = in_array($text, $menuTriggers, true) || str_starts_with($text, '/start ');

    if ($isMenuCmd) {
        if ($user['state'] !== '') {
            $pdo->prepare("UPDATE master_users SET state = '', state_data = '' WHERE user_id = ?")->execute([$userId]);
            $user['state'] = '';
            $user['state_data'] = '';
        }
    } elseif ($user['state'] !== '') {
        handleMasterState($pdo, $user, $chatId, $text);
        return;
    }

    if ($text === '/start' || str_starts_with($text, '/start ')) {
        sendMasterHome($pdo, $userId, $chatId);
    } elseif ($text === '🎁 Daily Coins' || $text === '/daily') {
        handleMasterDailyClaim($pdo, $userId, $chatId);
    } elseif ($text === '💰 My Balance' || $text === '/balance') {
        handleMasterBalance($pdo, $userId, $chatId);
    } elseif ($text === '👥 Refer & Earn' || $text === '/refer') {
        handleMasterRefer($pdo, $userId, $chatId);
    } elseif ($text === '🤖 Create Bot' || $text === '/create') {
        handleMasterCreateStart($pdo, $userId, $chatId);
    } elseif ($text === '📱 My Bots' || $text === '/mybots') {
        handleMasterMyBots($pdo, $userId, $chatId);
    } elseif ($text === '🆘 Support') {
        $sup = getSetting($pdo, 'support_username', '@Support');
        sendMsg($token, $chatId, "🆘 <b>Support</b>\n\nNeed help with your bot or coins?\nContact: " . esc($sup), masterMainKeyboard($userId));
    } else {
        sendMasterHome($pdo, $userId, $chatId);
    }
}

function sendMasterHome(PDO $pdo, int $userId, int $chatId, string $prefix = ''): void
{
    $stmt = $pdo->prepare("SELECT coins FROM master_users WHERE user_id = ?");
    $stmt->execute([$userId]);
    $coins = (int)$stmt->fetchColumn();
    $botCost = (int)getSetting($pdo, 'bot_cost', (string)DEFAULT_BOT_COST);
    $dailyCoins = (int)getSetting($pdo, 'daily_coins', (string)DEFAULT_DAILY_COINS);

    $msg = ($prefix !== '' ? "ℹ️ " . esc($prefix) . "\n\n" : '') .
        "🤖 <b>UPI Refer & Earn Bot Maker</b>\n\n" .
        "Build your own automated <b>UPI Refer & Earn Telegram Bot</b> with a full Admin Panel in seconds!\n\n" .
        "🪙 <b>Your Coins:</b> <code>{$coins}</code>\n" .
        "🏷 <b>1 Bot Cost:</b> <code>{$botCost} Coins</code>\n" .
        "🎁 <b>Daily Bonus:</b> <code>+{$dailyCoins} Coins/day</code>\n\n" .
        "Tap <b>🎁 Daily Coins</b> every 24h or invite friends to collect coins and launch your bot!";

    sendMsg(MASTER_BOT_TOKEN, $chatId, $msg, masterMainKeyboard($userId));
}

function handleMasterDailyClaim(PDO $pdo, int $userId, int $chatId): void
{
    $dailyCoins = (int)getSetting($pdo, 'daily_coins', (string)DEFAULT_DAILY_COINS);
    if ($dailyCoins <= 0) {
        sendMsg(MASTER_BOT_TOKEN, $chatId, "🎁 Daily coin bonus is currently disabled by admin.", masterMainKeyboard($userId));
        return;
    }

    $now = time();
    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare("SELECT coins, last_daily_at FROM master_users WHERE user_id = ?");
        $stmt->execute([$userId]);
        $row = $stmt->fetch();
        $last = (int)($row['last_daily_at'] ?? 0);
        $diff = $now - $last;
        if ($diff < 86400) {
            $pdo->commit();
            $wait = fmtDuration(86400 - $diff);
            sendMsg(
                MASTER_BOT_TOKEN,
                $chatId,
                "⏳ <b>Daily Coins Already Claimed</b>\n\nCome back in <b>{$wait}</b> to claim your next <b>+{$dailyCoins} Coins</b>!",
                masterMainKeyboard($userId)
            );
            return;
        }
        $pdo->prepare("UPDATE master_users SET coins = coins + ?, last_daily_at = ? WHERE user_id = ?")
            ->execute([$dailyCoins, $now, $userId]);
        $newCoins = (int)$row['coins'] + $dailyCoins;
        $pdo->commit();

        sendMsg(
            MASTER_BOT_TOKEN,
            $chatId,
            "🎉 <b>Daily Bonus Claimed!</b>\n\n" .
            "➕ Added: <b>+{$dailyCoins} Coins</b>\n" .
            "🪙 New Balance: <b>{$newCoins} Coins</b>",
            masterMainKeyboard($userId)
        );
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        sendMsg(MASTER_BOT_TOKEN, $chatId, "⚠️ Could not claim right now. Please try again.");
    }
}

function handleMasterBalance(PDO $pdo, int $userId, int $chatId): void
{
    $stmt = $pdo->prepare("SELECT coins, total_refs FROM master_users WHERE user_id = ?");
    $stmt->execute([$userId]);
    $u = $stmt->fetch();
    $botsStmt = $pdo->prepare("SELECT COUNT(*) FROM bots WHERE owner_id = ?");
    $botsStmt->execute([$userId]);
    $botsCount = (int)$botsStmt->fetchColumn();
    $botCost = (int)getSetting($pdo, 'bot_cost', (string)DEFAULT_BOT_COST);
    $needed = max(0, $botCost - (int)$u['coins']);

    $msg = "💰 <b>Your Account Balance</b>\n\n" .
        "🪙 <b>Coins:</b> <code>{$u['coins']}</code>\n" .
        "🤖 <b>Bots Created:</b> <code>{$botsCount}</code>\n" .
        "👥 <b>Total Referrals:</b> <code>{$u['total_refs']}</code>\n" .
        "🏷 <b>Bot Price:</b> <code>{$botCost} Coins</code>\n\n" .
        ($needed === 0
            ? "✅ You have enough coins to create a bot now! Tap <b>🤖 Create Bot</b>."
            : "📌 You need <b>{$needed} more coin(s)</b> to create a new bot.");

    sendMsg(MASTER_BOT_TOKEN, $chatId, $msg, masterMainKeyboard($userId));
}

function handleMasterRefer(PDO $pdo, int $userId, int $chatId): void
{
    $botUsername = getMasterBotUsername($pdo);
    $refCoins = (int)getSetting($pdo, 'master_ref_coins', (string)DEFAULT_MASTER_REF_COINS);
    $stmt = $pdo->prepare("SELECT total_refs FROM master_users WHERE user_id = ?");
    $stmt->execute([$userId]);
    $refs = (int)$stmt->fetchColumn();
    $link = "https://t.me/{$botUsername}?start={$userId}";

    $msg = "👥 <b>Refer & Earn Coins</b>\n\n" .
        "Invite friends using your link and earn <b>+{$refCoins} Coin(s)</b> for every verified user!\n\n" .
        "🔗 <b>Your Link:</b>\n<code>{$link}</code>\n\n" .
        "📊 <b>Total Verified Referrals:</b> <code>{$refs}</code>";

    $markup = [
        'inline_keyboard' => [
            [['text' => '📤 Share Link', 'url' => 'https://t.me/share/url?url=' . urlencode($link) . '&text=' . urlencode('Create your own UPI Refer & Earn Telegram Bot!')]],
        ],
    ];
    sendMsg(MASTER_BOT_TOKEN, $chatId, $msg, $markup);
}

function handleMasterCreateStart(PDO $pdo, int $userId, int $chatId): void
{
    $stmt = $pdo->prepare("SELECT coins FROM master_users WHERE user_id = ?");
    $stmt->execute([$userId]);
    $coins = (int)$stmt->fetchColumn();
    $botCost = (int)getSetting($pdo, 'bot_cost', (string)DEFAULT_BOT_COST);

    if ($coins < $botCost) {
        $need = $botCost - $coins;
        sendMsg(
            MASTER_BOT_TOKEN,
            $chatId,
            "❌ <b>Insufficient Coins</b>\n\n" .
            "Creating 1 UPI Refer & Earn Bot costs <b>{$botCost} Coins</b>.\n" .
            "Your Balance: <b>{$coins} Coins</b> (Need <b>{$need}</b> more).\n\n" .
            "Claim <b>🎁 Daily Coins</b> or use <b>👥 Refer & Earn</b>!",
            masterMainKeyboard($userId)
        );
        return;
    }

    $pdo->prepare("UPDATE master_users SET state = 'await_bot_token', state_data = '' WHERE user_id = ?")->execute([$userId]);
    $cancelKb = ['keyboard' => [[['text' => '❌ Cancel']]], 'resize_keyboard' => true];
    sendMsg(
        MASTER_BOT_TOKEN,
        $chatId,
        "🤖 <b>Create Your UPI Refer & Earn Bot</b>\n\n" .
        "💰 Cost: <b>{$botCost} Coins</b>\n\n" .
        "<b>Steps:</b>\n" .
        "1. Open @BotFather and send <code>/newbot</code>\n" .
        "2. Set your bot name & username\n" .
        "3. Copy the <b>HTTP API Token</b> and paste it here.\n\n" .
        "⏳ <i>Waiting for your Bot Token...</i>",
        $cancelKb
    );
}

function handleMasterMyBots(PDO $pdo, int $userId, int $chatId): void
{
    $stmt = $pdo->prepare("
        SELECT b.*, (SELECT COUNT(*) FROM child_users cu WHERE cu.bot_db_id = b.id) AS total_users
        FROM bots b WHERE b.owner_id = ? ORDER BY b.id DESC
    ");
    $stmt->execute([$userId]);
    $bots = $stmt->fetchAll();

    if (empty($bots)) {
        sendMsg(MASTER_BOT_TOKEN, $chatId, "📱 <b>My Bots</b>\n\nYou haven't created any bots yet. Tap <b>🤖 Create Bot</b> to launch your first UPI Refer & Earn Bot!", masterMainKeyboard($userId));
        return;
    }

    $rows = [];
    foreach ($bots as $b) {
        $st = (int)$b['is_active'] === 1 ? '🟢' : '⏸';
        $rows[] = [[
            'text' => "{$st} @{$b['bot_username']} ({$b['total_users']} users)",
            'callback_data' => 'mb_view:' . $b['id'],
        ]];
    }
    sendMsg(MASTER_BOT_TOKEN, $chatId, "📱 <b>Your Created Bots (" . count($bots) . ")</b>\n\nSelect a bot to manage:", ['inline_keyboard' => $rows]);
}

function handleMasterState(PDO $pdo, array $user, int $chatId, string $text): void
{
    $userId = (int)$user['user_id'];
    $state = (string)$user['state'];
    $stateData = json_decode((string)$user['state_data'], true) ?: [];

    if ($state === 'await_bot_token') {
        $tokenInput = trim($text);
        if (!preg_match('/^\d{6,15}:[A-Za-z0-9_-]{25,}$/', $tokenInput)) {
            sendMsg(MASTER_BOT_TOKEN, $chatId, "❌ Invalid Bot Token format. Please paste the exact token from @BotFather or tap <b>❌ Cancel</b>.");
            return;
        }
        if ($tokenInput === MASTER_BOT_TOKEN) {
            sendMsg(MASTER_BOT_TOKEN, $chatId, "❌ You cannot use the Master Bot token.");
            return;
        }

        $dup = $pdo->prepare("SELECT id FROM bots WHERE token = ?");
        $dup->execute([$tokenInput]);
        if ($dup->fetchColumn()) {
            sendMsg(MASTER_BOT_TOKEN, $chatId, "❌ This bot token is already registered.");
            return;
        }

        $me = tgApi($tokenInput, 'getMe');
        if (!($me['ok'] ?? false)) {
            sendMsg(MASTER_BOT_TOKEN, $chatId, "❌ Telegram rejected this token: <code>" . esc($me['description'] ?? 'Invalid token') . "</code>");
            return;
        }
        $botInfo = $me['result'];
        $tgBotId = (int)$botInfo['id'];
        $tgUsername = (string)($botInfo['username'] ?? '');
        $tgName = (string)($botInfo['first_name'] ?? 'UPI Earn Bot');

        $botCost = (int)getSetting($pdo, 'bot_cost', (string)DEFAULT_BOT_COST);
        $now = time();

        $pdo->beginTransaction();
        try {
            $uStmt = $pdo->prepare("SELECT coins FROM master_users WHERE user_id = ?");
            $uStmt->execute([$userId]);
            $currCoins = (int)$uStmt->fetchColumn();
            if ($currCoins < $botCost) {
                $pdo->commit();
                $pdo->prepare("UPDATE master_users SET state = '' WHERE user_id = ?")->execute([$userId]);
                sendMsg(MASTER_BOT_TOKEN, $chatId, "❌ Insufficient coins ({$currCoins}/{$botCost}).", masterMainKeyboard($userId));
                return;
            }

            $pdo->prepare("UPDATE master_users SET coins = coins - ?, state = '', state_data = '' WHERE user_id = ?")
                ->execute([$botCost, $userId]);

            $ins = $pdo->prepare("
                INSERT INTO bots (owner_id, token, bot_id_tg, bot_username, bot_name, is_active, per_refer, min_withdraw, daily_bonus, currency, withdrawals_open, support_username, created_at)
                VALUES (?, ?, ?, ?, ?, 1, 10.0, 50.0, 5.0, '₹', 1, ?, ?)
            ");
            $sup = $user['username'] !== '' ? ('@' . $user['username']) : '';
            $ins->execute([$userId, $tokenInput, $tgBotId, $tgUsername, $tgName, $sup, $now]);
            $newBotId = (int)$pdo->lastInsertId();
            $pdo->commit();

            $hookUrl = getWebhookBaseUrl() . '?bot_id=' . $newBotId;
            $hookParams = ['url' => $hookUrl, 'drop_pending_updates' => true];
            if (SETUP_SECRET !== '') {
                $hookParams['secret_token'] = SETUP_SECRET;
            }
            $hookRes = tgApi($tokenInput, 'setWebhook', $hookParams);
            if (!($hookRes['ok'] ?? false)) {
                $pdo->prepare("DELETE FROM bots WHERE id = ?")->execute([$newBotId]);
                $pdo->prepare("UPDATE master_users SET coins = coins + ? WHERE user_id = ?")->execute([$botCost, $userId]);
                throw new RuntimeException('Webhook error: ' . ($hookRes['description'] ?? 'Failed'));
            }

            sendMsg(
                MASTER_BOT_TOKEN,
                $chatId,
                "🎉 <b>Your UPI Refer & Earn Bot is LIVE!</b>\n\n" .
                "🤖 <b>Bot:</b> @" . esc($tgUsername) . "\n" .
                "🪙 <b>Coins Deducted:</b> <code>-{$botCost}</code>\n\n" .
                "👑 <b>How to open YOUR Bot Admin Panel:</b>\n" .
                "Open @" . esc($tgUsername) . " and send <code>/admin</code> (or tap <b>👑 Admin Panel</b>).\n" .
                "From there you can approve/reject UPI withdrawals, set per-refer ₹, min withdraw ₹, add force channels, and broadcast!",
                masterMainKeyboard($userId)
            );
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            $pdo->prepare("UPDATE master_users SET state = '' WHERE user_id = ?")->execute([$userId]);
            sendMsg(MASTER_BOT_TOKEN, $chatId, "❌ Could not deploy bot: <code>" . esc($e->getMessage()) . "</code>\nYour coins were not charged.", masterMainKeyboard($userId));
        }
        return;
    }

    if (!isMasterAdmin($userId)) {
        $pdo->prepare("UPDATE master_users SET state = '', state_data = '' WHERE user_id = ?")->execute([$userId]);
        sendMasterHome($pdo, $userId, $chatId);
        return;
    }

    if ($state === 'ma_find_user') {
        $q = ltrim(trim($text), '@');
        $stmt = ctype_digit($q)
            ? $pdo->prepare("SELECT * FROM master_users WHERE user_id = ?")
            : $pdo->prepare("SELECT * FROM master_users WHERE LOWER(username) = LOWER(?)");
        $stmt->execute([$q]);
        $target = $stmt->fetch();
        $pdo->prepare("UPDATE master_users SET state = '' WHERE user_id = ?")->execute([$userId]);
        if (!$target) {
            sendMsg(MASTER_BOT_TOKEN, $chatId, "❌ User not found.", masterMainKeyboard($userId));
            return;
        }
        sendMasterUserCard($pdo, $chatId, (int)$target['user_id']);
        return;
    }

    if ($state === 'ma_add_coins' || $state === 'ma_sub_coins') {
        $targetId = (int)($stateData['target_id'] ?? 0);
        if (!ctype_digit($text) || (int)$text <= 0) {
            sendMsg(MASTER_BOT_TOKEN, $chatId, "❌ Enter a valid positive integer amount.");
            return;
        }
        $amt = (int)$text;
        $pdo->prepare("UPDATE master_users SET state = '', state_data = '' WHERE user_id = ?")->execute([$userId]);
        if ($state === 'ma_add_coins') {
            $pdo->prepare("UPDATE master_users SET coins = coins + ? WHERE user_id = ?")->execute([$amt, $targetId]);
            sendMsg(MASTER_BOT_TOKEN, $targetId, "🪙 Admin added <b>+{$amt} Coins</b> to your account!");
        } else {
            $pdo->prepare("UPDATE master_users SET coins = MAX(0, coins - ?) WHERE user_id = ?")->execute([$amt, $targetId]);
        }
        sendMasterUserCard($pdo, $chatId, $targetId, true);
        return;
    }

    if ($state === 'ma_add_channel') {
        $res = resolveChannelInput(MASTER_BOT_TOKEN, $text);
        if (!$res['ok']) {
            sendMsg(MASTER_BOT_TOKEN, $chatId, "❌ " . $res['error'] . "\n\nTry again or send /cancel.");
            return;
        }
        $pdo->prepare("UPDATE master_users SET state = '' WHERE user_id = ?")->execute([$userId]);
        $pdo->prepare("INSERT INTO master_channels (chat_id, title, invite_link, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title, invite_link = excluded.invite_link")
            ->execute([$res['chat_id'], $res['title'], $res['invite_link'], time()]);
        sendMsg(MASTER_BOT_TOKEN, $chatId, "✅ Force channel added: <b>" . esc($res['title']) . "</b>", masterMainKeyboard($userId));
        sendMasterChannelsMenu($pdo, $chatId);
        return;
    }

    if (str_starts_with($state, 'ma_set:')) {
        $key = substr($state, 7);
        $val = trim($text);
        if (in_array($key, ['daily_coins', 'bot_cost', 'master_ref_coins'], true)) {
            if (!ctype_digit($val)) {
                sendMsg(MASTER_BOT_TOKEN, $chatId, "❌ Please enter a valid whole number (0 or higher).");
                return;
            }
            if ($key === 'bot_cost' && (int)$val < 1) {
                sendMsg(MASTER_BOT_TOKEN, $chatId, "❌ Bot cost must be at least 1 coin.");
                return;
            }
        }
        setSetting($pdo, $key, $val);
        $pdo->prepare("UPDATE master_users SET state = '' WHERE user_id = ?")->execute([$userId]);
        sendMsg(MASTER_BOT_TOKEN, $chatId, "✅ Setting <b>" . esc($key) . "</b> updated to <code>" . esc($val) . "</code>.", masterMainKeyboard($userId));
        sendMasterSettingsMenu($pdo, $chatId);
        return;
    }

    if ($state === 'ma_bc_pick_bot') {
        $q = ltrim(trim($text), '@');
        $stmt = ctype_digit($q)
            ? $pdo->prepare("SELECT * FROM bots WHERE id = ?")
            : $pdo->prepare("SELECT * FROM bots WHERE LOWER(bot_username) = LOWER(?)");
        $stmt->execute([$q]);
        $bot = $stmt->fetch();
        if (!$bot) {
            sendMsg(MASTER_BOT_TOKEN, $chatId, "❌ Child bot not found. Enter valid @username or numeric Bot ID, or /cancel.");
            return;
        }
        $pdo->prepare("UPDATE master_users SET state = 'ma_bc_msg', state_data = ? WHERE user_id = ?")
            ->execute([json_encode(['target' => 'one_child', 'bot_db_id' => (int)$bot['id'], 'bot_username' => $bot['bot_username']]), $userId]);
        sendMsg(MASTER_BOT_TOKEN, $chatId, "🎯 Selected <b>@" . esc($bot['bot_username']) . "</b>.\n\nNow send the broadcast message (HTML supported):");
        return;
    }

    if ($state === 'ma_bc_msg') {
        $stateData['msg'] = $text;
        $pdo->prepare("UPDATE master_users SET state = 'ma_bc_btn', state_data = ? WHERE user_id = ?")
            ->execute([json_encode($stateData), $userId]);
        sendMsg(
            MASTER_BOT_TOKEN,
            $chatId,
            "🔘 Optional URL Button:\nSend <code>Button Label | https://example.com</code>\nOr send <code>skip</code> to send without a button."
        );
        return;
    }

    if ($state === 'ma_bc_btn') {
        $btn = null;
        if (strtolower($text) !== 'skip') {
            if (strpos($text, '|') === false) {
                sendMsg(MASTER_BOT_TOKEN, $chatId, "❌ Invalid format. Use <code>Label | https://url.com</code> or type <code>skip</code>.");
                return;
            }
            [$lbl, $url] = array_map('trim', explode('|', $text, 2));
            if (!filter_var($url, FILTER_VALIDATE_URL)) {
                sendMsg(MASTER_BOT_TOKEN, $chatId, "❌ Invalid URL. Must start with https:// or http://");
                return;
            }
            $btn = ['text' => $lbl, 'url' => $url];
        }
        $stateData['btn'] = $btn;
        $pdo->prepare("UPDATE master_users SET state = '', state_data = ? WHERE user_id = ?")
            ->execute([json_encode($stateData), $userId]);

        $targetLabel = match ($stateData['target'] ?? 'master') {
            'all_child' => '🌐 ALL Child Bots Users',
            'one_child' => '🎯 Child Bot @' . ($stateData['bot_username'] ?? ''),
            default => '📣 Master Bot Users',
        };
        $previewMarkup = [
            'inline_keyboard' => [
                [['text' => '✅ Confirm & Send Broadcast', 'callback_data' => 'ma_bc_exec']],
                [['text' => '❌ Cancel', 'callback_data' => 'ma_home']],
            ],
        ];
        sendMsg(
            MASTER_BOT_TOKEN,
            $chatId,
            "📋 <b>Broadcast Preview</b>\n<b>Target:</b> " . esc($targetLabel) . "\n\n" . $stateData['msg'],
            $previewMarkup
        );
        return;
    }
}

function handleMasterCallback(PDO $pdo, array $user, array $cb): void
{
    $token = MASTER_BOT_TOKEN;
    $userId = (int)$user['user_id'];
    $chatId = (int)$cb['message']['chat']['id'];
    $msgId = (int)$cb['message']['message_id'];
    $data = (string)$cb['data'];

    if (str_starts_with($data, 'mb_view:')) {
        $botId = (int)substr($data, 8);
        $stmt = $pdo->prepare("SELECT b.*, (SELECT COUNT(*) FROM child_users WHERE bot_db_id = b.id) AS total_users FROM bots b WHERE b.id = ? AND b.owner_id = ?");
        $stmt->execute([$botId, $userId]);
        $b = $stmt->fetch();
        if (!$b) {
            answerCb($token, $cb['id'], 'Bot not found.', true);
            return;
        }
        answerCb($token, $cb['id']);
        $st = (int)$b['is_active'] === 1 ? '🟢 Active' : '⏸ Paused';
        $toggleLbl = (int)$b['is_active'] === 1 ? '⏸ Pause Bot' : '▶️ Resume Bot';
        $txt = "🤖 <b>@" . esc($b['bot_username']) . "</b>\n\n" .
            "Status: <b>{$st}</b>\n" .
            "Users: <code>{$b['total_users']}</code>\n" .
            "Per Refer: <code>" . esc($b['currency']) . fmtNum((float)$b['per_refer']) . "</code>\n" .
            "Min Withdraw: <code>" . esc($b['currency']) . fmtNum((float)$b['min_withdraw']) . "</code>\n\n" .
            "Link: https://t.me/" . esc($b['bot_username']) . "\n" .
            "Admin Command inside bot: <code>/admin</code>";
        $kb = [
            'inline_keyboard' => [
                [['text' => '🔗 Open Bot', 'url' => 'https://t.me/' . $b['bot_username']]],
                [['text' => $toggleLbl, 'callback_data' => "mb_toggle:{$botId}"], ['text' => '🔄 Sync Webhook', 'callback_data' => "mb_sync:{$botId}"]],
                [['text' => '🗑 Delete Bot', 'callback_data' => "mb_del:{$botId}"], ['text' => '⬅️ Back', 'callback_data' => 'mb_list']],
            ],
        ];
        editMsg($token, $chatId, $msgId, $txt, $kb);
        return;
    }

    if ($data === 'mb_list') {
        answerCb($token, $cb['id']);
        tgApi($token, 'deleteMessage', ['chat_id' => $chatId, 'message_id' => $msgId]);
        handleMasterMyBots($pdo, $userId, $chatId);
        return;
    }

    if (str_starts_with($data, 'mb_toggle:')) {
        $botId = (int)substr($data, 10);
        $pdo->prepare("UPDATE bots SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ? AND owner_id = ?")
            ->execute([$botId, $userId]);
        answerCb($token, $cb['id'], 'Bot status updated.');
        $cb['data'] = 'mb_view:' . $botId;
        handleMasterCallback($pdo, $user, $cb);
        return;
    }

    if (str_starts_with($data, 'mb_sync:')) {
        $botId = (int)substr($data, 8);
        $stmt = $pdo->prepare("SELECT token FROM bots WHERE id = ? AND owner_id = ?");
        $stmt->execute([$botId, $userId]);
        $t = $stmt->fetchColumn();
        if ($t) {
            $hp = ['url' => getWebhookBaseUrl() . '?bot_id=' . $botId];
            if (SETUP_SECRET !== '') {
                $hp['secret_token'] = SETUP_SECRET;
            }
            $r = tgApi((string)$t, 'setWebhook', $hp);
            answerCb($token, $cb['id'], ($r['ok'] ?? false) ? 'Webhook synced!' : ('Error: ' . ($r['description'] ?? 'Failed')), true);
        }
        return;
    }

    if (str_starts_with($data, 'mb_del:')) {
        $botId = (int)substr($data, 7);
        answerCb($token, $cb['id']);
        editMsg($token, $chatId, $msgId, "⚠️ <b>Confirm Bot Deletion</b>\n\nAll users and data inside this child bot will be permanently deleted.", [
            'inline_keyboard' => [
                [['text' => '✅ Yes, Delete Permanently', 'callback_data' => "mb_del_ok:{$botId}"]],
                [['text' => '❌ Cancel', 'callback_data' => "mb_view:{$botId}"]],
            ],
        ]);
        return;
    }

    if (str_starts_with($data, 'mb_del_ok:')) {
        $botId = (int)substr($data, 10);
        $stmt = $pdo->prepare("SELECT token FROM bots WHERE id = ? AND owner_id = ?");
        $stmt->execute([$botId, $userId]);
        $t = $stmt->fetchColumn();
        if ($t) {
            tgApi((string)$t, 'deleteWebhook', ['drop_pending_updates' => true]);
            $pdo->prepare("DELETE FROM bots WHERE id = ? AND owner_id = ?")->execute([$botId, $userId]);
        }
        answerCb($token, $cb['id'], 'Bot deleted.');
        editMsg($token, $chatId, $msgId, "🗑 Bot deleted successfully.");
        return;
    }

    if (!isMasterAdmin($userId)) {
        answerCb($token, $cb['id'], 'Unauthorized.', true);
        return;
    }

    if ($data === 'ma_home') {
        $pdo->prepare("UPDATE master_users SET state = '', state_data = '' WHERE user_id = ?")->execute([$userId]);
        answerCb($token, $cb['id']);
        sendMasterAdminMenu($pdo, $chatId, $msgId);
        return;
    }

    if ($data === 'ma_stats') {
        answerCb($token, $cb['id']);
        $now = time();
        $totalUsers = (int)$pdo->query("SELECT COUNT(*) FROM master_users")->fetchColumn();
        $active24h = (int)$pdo->query("SELECT COUNT(*) FROM master_users WHERE last_active_at >= " . ($now - 86400))->fetchColumn();
        $banned = (int)$pdo->query("SELECT COUNT(*) FROM master_users WHERE is_banned = 1")->fetchColumn();
        $totalCoins = (int)$pdo->query("SELECT COALESCE(SUM(coins),0) FROM master_users")->fetchColumn();
        $totalBots = (int)$pdo->query("SELECT COUNT(*) FROM bots")->fetchColumn();
        $activeBots = (int)$pdo->query("SELECT COUNT(*) FROM bots WHERE is_active = 1")->fetchColumn();
        $childUsers = (int)$pdo->query("SELECT COUNT(*) FROM child_users")->fetchColumn();

        $txt = "📊 <b>Master Bot &amp; Ecosystem Status</b>\n\n" .
            "👥 <b>Master Users:</b> <code>{$totalUsers}</code>\n" .
            "🟢 <b>Active (24h):</b> <code>{$active24h}</code>\n" .
            "🚫 <b>Banned Users:</b> <code>{$banned}</code>\n" .
            "🪙 <b>Total Coins Held:</b> <code>{$totalCoins}</code>\n\n" .
            "🤖 <b>Created Child Bots:</b> <code>{$totalBots}</code> (<code>{$activeBots}</code> active)\n" .
            "🌐 <b>Total Child Bot Users:</b> <code>{$childUsers}</code>";
        editMsg($token, $chatId, $msgId, $txt, [
            'inline_keyboard' => [
                [['text' => '🔄 Refresh', 'callback_data' => 'ma_stats'], ['text' => '📋 Users List', 'callback_data' => 'ma_users:0']],
                [['text' => '⬅️ Admin Menu', 'callback_data' => 'ma_home']],
            ],
        ]);
        return;
    }

    if ($data === 'ma_find_user') {
        answerCb($token, $cb['id']);
        $pdo->prepare("UPDATE master_users SET state = 'ma_find_user' WHERE user_id = ?")->execute([$userId]);
        sendMsg($token, $chatId, "🔍 Send the user's <b>Telegram ID</b> or <b>@username</b> (or /cancel):");
        return;
    }

    if (str_starts_with($data, 'ma_users:')) {
        answerCb($token, $cb['id']);
        $page = max(0, (int)substr($data, 9));
        $limit = 10;
        $offset = $page * $limit;
        $rows = $pdo->query("
            SELECT u.*, (SELECT COUNT(*) FROM bots b WHERE b.owner_id = u.user_id) AS bot_cnt
            FROM master_users u ORDER BY u.last_active_at DESC LIMIT {$limit} OFFSET {$offset}
        ")->fetchAll();

        $txt = "📋 <b>Users List (Page " . ($page + 1) . ")</b>\nTap a user to inspect or manage:";
        $kbRows = [];
        foreach ($rows as $r) {
            $st = (int)$r['is_banned'] === 1 ? '🚫' : '🟢';
            $un = $r['username'] !== '' ? ('@' . $r['username']) : $r['first_name'];
            $kbRows[] = [[
                'text' => "{$st} {$un} | {$r['coins']}🪙 | {$r['bot_cnt']} bots",
                'callback_data' => 'ma_u_view:' . $r['user_id'],
            ]];
        }
        $nav = [];
        if ($page > 0) {
            $nav[] = ['text' => '⬅️ Prev', 'callback_data' => 'ma_users:' . ($page - 1)];
        }
        if (count($rows) === $limit) {
            $nav[] = ['text' => 'Next ➡️', 'callback_data' => 'ma_users:' . ($page + 1)];
        }
        if (!empty($nav)) {
            $kbRows[] = $nav;
        }
        $kbRows[] = [['text' => '⬅️ Admin Menu', 'callback_data' => 'ma_home']];
        editMsg($token, $chatId, $msgId, $txt, ['inline_keyboard' => $kbRows]);
        return;
    }

    if (str_starts_with($data, 'ma_u_view:')) {
        answerCb($token, $cb['id']);
        sendMasterUserCard($pdo, $chatId, (int)substr($data, 10), false, $msgId);
        return;
    }

    if (str_starts_with($data, 'ma_u_add:') || str_starts_with($data, 'ma_u_sub:')) {
        answerCb($token, $cb['id']);
        $isAdd = str_starts_with($data, 'ma_u_add:');
        $tid = (int)substr($data, 9);
        $stName = $isAdd ? 'ma_add_coins' : 'ma_sub_coins';
        $pdo->prepare("UPDATE master_users SET state = ?, state_data = ? WHERE user_id = ?")
            ->execute([$stName, json_encode(['target_id' => $tid]), $userId]);
        sendMsg($token, $chatId, ($isAdd ? "➕" : "➖") . " Enter coin amount for user <code>{$tid}</code> (or /cancel):");
        return;
    }

    if (str_starts_with($data, 'ma_u_ban:')) {
        $tid = (int)substr($data, 9);
        if (isMasterAdmin($tid)) {
            answerCb($token, $cb['id'], 'Cannot ban Master Admin.', true);
            return;
        }
        $pdo->prepare("UPDATE master_users SET is_banned = CASE WHEN is_banned = 1 THEN 0 ELSE 1 END WHERE user_id = ?")->execute([$tid]);
        answerCb($token, $cb['id'], 'Updated ban status.');
        sendMasterUserCard($pdo, $chatId, $tid, false, $msgId);
        return;
    }

    if ($data === 'ma_channels') {
        answerCb($token, $cb['id']);
        sendMasterChannelsMenu($pdo, $chatId, $msgId);
        return;
    }

    if ($data === 'ma_ch_add') {
        answerCb($token, $cb['id']);
        $pdo->prepare("UPDATE master_users SET state = 'ma_add_channel' WHERE user_id = ?")->execute([$userId]);
        sendMsg(
            MASTER_BOT_TOKEN,
            $chatId,
            "📢 <b>Add Force Channel</b>\n\n" .
            "First, add this Master Bot as an <b>Admin</b> in your channel.\n" .
            "Then send <code>@ChannelUsername</code>\n" .
            "Or for private channels: <code>-1001234567890 | https://t.me/+InviteLink</code>"
        );
        return;
    }

    if (str_starts_with($data, 'ma_ch_del:')) {
        $cid = (int)substr($data, 10);
        $pdo->prepare("DELETE FROM master_channels WHERE id = ?")->execute([$cid]);
        answerCb($token, $cb['id'], 'Channel removed.');
        sendMasterChannelsMenu($pdo, $chatId, $msgId);
        return;
    }

    if ($data === 'ma_settings') {
        answerCb($token, $cb['id']);
        sendMasterSettingsMenu($pdo, $chatId, $msgId);
        return;
    }

    if (str_starts_with($data, 'ma_set:')) {
        answerCb($token, $cb['id']);
        $key = substr($data, 7);
        $pdo->prepare("UPDATE master_users SET state = ? WHERE user_id = ?")->execute(['ma_set:' . $key, $userId]);
        sendMsg($token, $chatId, "✏️ Enter new value for <b>" . esc($key) . "</b> (or /cancel):");
        return;
    }

    if ($data === 'ma_toggle_maint') {
        $curr = getSetting($pdo, 'maintenance', '0');
        setSetting($pdo, 'maintenance', $curr === '1' ? '0' : '1');
        answerCb($token, $cb['id'], 'Maintenance mode toggled.');
        sendMasterSettingsMenu($pdo, $chatId, $msgId);
        return;
    }

    if ($data === 'ma_broadcast') {
        answerCb($token, $cb['id']);
        editMsg($token, $chatId, $msgId, "📣 <b>Broadcast Center</b>\n\nChoose who should receive your broadcast:", [
            'inline_keyboard' => [
                [['text' => '📣 Master Bot Users', 'callback_data' => 'ma_bc_t:master']],
                [['text' => '🌐 ALL Child Bots (Every User)', 'callback_data' => 'ma_bc_t:all_child']],
                [['text' => '🎯 Specific Child Bot', 'callback_data' => 'ma_bc_t:one_child']],
                [['text' => '⬅️ Admin Menu', 'callback_data' => 'ma_home']],
            ],
        ]);
        return;
    }

    if (str_starts_with($data, 'ma_bc_t:')) {
        answerCb($token, $cb['id']);
        $target = substr($data, 8);
        if ($target === 'one_child') {
            $pdo->prepare("UPDATE master_users SET state = 'ma_bc_pick_bot' WHERE user_id = ?")->execute([$userId]);
            sendMsg($token, $chatId, "🎯 Enter the Child Bot <b>@username</b> or numeric <b>Bot ID</b>:");
        } else {
            $pdo->prepare("UPDATE master_users SET state = 'ma_bc_msg', state_data = ? WHERE user_id = ?")
                ->execute([json_encode(['target' => $target]), $userId]);
            sendMsg($token, $chatId, "📝 Send your broadcast message (HTML formatting like &lt;b&gt;, &lt;i&gt;, &lt;a&gt; supported):");
        }
        return;
    }

    if ($data === 'ma_bc_exec') {
        $sd = json_decode((string)$user['state_data'], true);
        if (!$sd || empty($sd['msg'])) {
            answerCb($token, $cb['id'], 'No pending broadcast.', true);
            return;
        }
        answerCb($token, $cb['id'], 'Starting broadcast...');
        $pdo->prepare("UPDATE master_users SET state_data = '' WHERE user_id = ?")->execute([$userId]);
        $markup = !empty($sd['btn']) ? ['inline_keyboard' => [[$sd['btn']]]] : null;
        $target = $sd['target'] ?? 'master';

        editMsg($token, $chatId, $msgId, "⏳ <b>Broadcasting in progress...</b> Please wait.");

        if ($target === 'master') {
            $uids = $pdo->query("SELECT user_id FROM master_users WHERE is_banned = 0")->fetchAll(PDO::FETCH_COLUMN);
            $res = executeBroadcast($token, $uids, $sd['msg'], $markup);
            sendMsg($token, $chatId, "✅ <b>Master Broadcast Complete</b>\n\n📤 Sent: <code>{$res['sent']}</code>\n❌ Failed/Blocked: <code>{$res['failed']}</code>");
        } elseif ($target === 'one_child') {
            $bid = (int)($sd['bot_db_id'] ?? 0);
            $bStmt = $pdo->prepare("SELECT token, bot_username FROM bots WHERE id = ?");
            $bStmt->execute([$bid]);
            $bot = $bStmt->fetch();
            if ($bot) {
                $uStmt = $pdo->prepare("SELECT user_id FROM child_users WHERE bot_db_id = ? AND is_banned = 0");
                $uStmt->execute([$bid]);
                $uids = $uStmt->fetchAll(PDO::FETCH_COLUMN);
                $res = executeBroadcast($bot['token'], $uids, $sd['msg'], $markup);
                sendMsg($token, $chatId, "✅ <b>Broadcast Complete (@" . esc($bot['bot_username']) . ")</b>\n\n📤 Sent: <code>{$res['sent']}</code>\n❌ Failed: <code>{$res['failed']}</code>");
            }
        } elseif ($target === 'all_child') {
            $bots = $pdo->query("SELECT id, token FROM bots WHERE is_active = 1")->fetchAll();
            $totalSent = 0;
            $totalFailed = 0;
            $botsCount = 0;
            $uStmt = $pdo->prepare("SELECT user_id FROM child_users WHERE bot_db_id = ? AND is_banned = 0");
            foreach ($bots as $b) {
                $uStmt->execute([(int)$b['id']]);
                $uids = $uStmt->fetchAll(PDO::FETCH_COLUMN);
                if (empty($uids)) {
                    continue;
                }
                $botsCount++;
                $res = executeBroadcast($b['token'], $uids, $sd['msg'], $markup);
                $totalSent += $res['sent'];
                $totalFailed += $res['failed'];
            }
            sendMsg(
                $token,
                $chatId,
                "🌐 <b>Global Child-Bots Broadcast Complete</b>\n\n" .
                "🤖 Child Bots Reached: <code>{$botsCount}</code>\n" .
                "📤 Total Sent: <code>{$totalSent}</code>\n" .
                "❌ Total Failed: <code>{$totalFailed}</code>"
            );
        }
        return;
    }

    if (str_starts_with($data, 'ma_bots:')) {
        answerCb($token, $cb['id']);
        $page = max(0, (int)substr($data, 8));
        $limit = 10;
        $offset = $page * $limit;
        $bots = $pdo->query("
            SELECT b.*, (SELECT COUNT(*) FROM child_users cu WHERE cu.bot_db_id = b.id) AS ucnt
            FROM bots b ORDER BY b.id DESC LIMIT {$limit} OFFSET {$offset}
        ")->fetchAll();
        $kbRows = [];
        foreach ($bots as $b) {
            $st = (int)$b['is_active'] === 1 ? '🟢' : '🚫';
            $kbRows[] = [[
                'text' => "{$st} #{$b['id']} @{$b['bot_username']} ({$b['ucnt']} users)",
                'callback_data' => 'ma_bot_v:' . $b['id'],
            ]];
        }
        $nav = [];
        if ($page > 0) {
            $nav[] = ['text' => '⬅️ Prev', 'callback_data' => 'ma_bots:' . ($page - 1)];
        }
        if (count($bots) === $limit) {
            $nav[] = ['text' => 'Next ➡️', 'callback_data' => 'ma_bots:' . ($page + 1)];
        }
        if (!empty($nav)) {
            $kbRows[] = $nav;
        }
        $kbRows[] = [['text' => '⬅️ Admin Menu', 'callback_data' => 'ma_home']];
        editMsg($token, $chatId, $msgId, "🤖 <b>All Created Child Bots</b>\nTap a bot to manage:", ['inline_keyboard' => $kbRows]);
        return;
    }

    if (str_starts_with($data, 'ma_bot_v:')) {
        answerCb($token, $cb['id']);
        sendMasterBotCard($pdo, $chatId, (int)substr($data, 9), $msgId);
        return;
    }

    if (str_starts_with($data, 'ma_bot_tog:')) {
        $bid = (int)substr($data, 11);
        $pdo->prepare("UPDATE bots SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE id = ?")->execute([$bid]);
        answerCb($token, $cb['id'], 'Child bot status updated.');
        sendMasterBotCard($pdo, $chatId, $bid, $msgId);
        return;
    }

    if (str_starts_with($data, 'ma_bot_del:')) {
        $bid = (int)substr($data, 11);
        $stmt = $pdo->prepare("SELECT token FROM bots WHERE id = ?");
        $stmt->execute([$bid]);
        $t = $stmt->fetchColumn();
        if ($t) {
            tgApi((string)$t, 'deleteWebhook', ['drop_pending_updates' => true]);
            $pdo->prepare("DELETE FROM bots WHERE id = ?")->execute([$bid]);
        }
        answerCb($token, $cb['id'], 'Bot deleted.');
        editMsg($token, $chatId, $msgId, "🗑 Child bot #{$bid} deleted.", [
            'inline_keyboard' => [[['text' => '🤖 All Child Bots', 'callback_data' => 'ma_bots:0']]],
        ]);
        return;
    }
}

function sendMasterBotCard(PDO $pdo, int $chatId, int $bid, int $msgId): void
{
    $stmt = $pdo->prepare("SELECT b.*, (SELECT COUNT(*) FROM child_users WHERE bot_db_id = b.id) AS ucnt FROM bots b WHERE b.id = ?");
    $stmt->execute([$bid]);
    $b = $stmt->fetch();
    if (!$b) {
        return;
    }
    $st = (int)$b['is_active'] === 1 ? '🟢 Active' : '🚫 Suspended';
    $toggleLbl = (int)$b['is_active'] === 1 ? '🚫 Suspend Bot' : '✅ Activate Bot';
    $txt = "🤖 <b>Child Bot #{$b['id']}</b>\n\n" .
        "Username: @" . esc($b['bot_username']) . "\n" .
        "Owner ID: <code>{$b['owner_id']}</code>\n" .
        "Users: <code>{$b['ucnt']}</code>\n" .
        "Status: <b>{$st}</b>";
    editMsg(MASTER_BOT_TOKEN, $chatId, $msgId, $txt, [
        'inline_keyboard' => [
            [['text' => $toggleLbl, 'callback_data' => "ma_bot_tog:{$bid}"], ['text' => '🗑 Delete Bot', 'callback_data' => "ma_bot_del:{$bid}"]],
            [['text' => '👤 Inspect Owner', 'callback_data' => "ma_u_view:{$b['owner_id']}"], ['text' => '⬅️ Bots List', 'callback_data' => 'ma_bots:0']],
        ],
    ]);
}

function sendMasterAdminMenu(PDO $pdo, int $chatId, ?int $editMsgId = null): void
{
    $dailyCoins = getSetting($pdo, 'daily_coins', (string)DEFAULT_DAILY_COINS);
    $botCost = getSetting($pdo, 'bot_cost', (string)DEFAULT_BOT_COST);
    $txt = "🛡 <b>Master Admin Panel</b>\n\n" .
        "🎁 Daily Bonus: <code>{$dailyCoins} Coins</code> · 🤖 Bot Cost: <code>{$botCost} Coins</code>\n" .
        "<i>Manage users, force channels, daily coins, child bots &amp; global broadcasts.</i>";
    $kb = [
        'inline_keyboard' => [
            [['text' => '📊 Users & Status', 'callback_data' => 'ma_stats'], ['text' => '🔍 Find User', 'callback_data' => 'ma_find_user']],
            [['text' => '📋 Users List', 'callback_data' => 'ma_users:0'], ['text' => '🤖 Manage Child Bots', 'callback_data' => 'ma_bots:0']],
            [['text' => '📢 Force Channels', 'callback_data' => 'ma_channels'], ['text' => '📣 Broadcast', 'callback_data' => 'ma_broadcast']],
            [['text' => '🪙 Coins & Bot Settings', 'callback_data' => 'ma_settings']],
        ],
    ];
    if ($editMsgId !== null) {
        editMsg(MASTER_BOT_TOKEN, $chatId, $editMsgId, $txt, $kb);
    } else {
        sendMsg(MASTER_BOT_TOKEN, $chatId, $txt, $kb);
    }
}

function sendMasterUserCard(PDO $pdo, int $chatId, int $targetId, bool $sendNew = false, ?int $editMsgId = null): void
{
    $stmt = $pdo->prepare("SELECT * FROM master_users WHERE user_id = ?");
    $stmt->execute([$targetId]);
    $u = $stmt->fetch();
    if (!$u) {
        return;
    }
    $bStmt = $pdo->prepare("SELECT COUNT(*) FROM bots WHERE owner_id = ?");
    $bStmt->execute([$targetId]);
    $botsCnt = (int)$bStmt->fetchColumn();
    $st = (int)$u['is_banned'] === 1 ? '🚫 Banned' : '🟢 Active';
    $banLbl = (int)$u['is_banned'] === 1 ? '✅ Unban User' : '🚫 Ban User';
    $txt = "👤 <b>User Profile</b>\n\n" .
        "ID: <code>{$u['user_id']}</code>\n" .
        "Name: <b>" . esc($u['first_name']) . "</b>\n" .
        "Username: " . ($u['username'] !== '' ? '@' . esc($u['username']) : '<i>None</i>') . "\n" .
        "Status: <b>{$st}</b>\n" .
        "🪙 Coins: <code>{$u['coins']}</code>\n" .
        "🤖 Bots Created: <code>{$botsCnt}</code>\n" .
        "👥 Referrals: <code>{$u['total_refs']}</code>\n" .
        "🕒 Last Active: " . date('Y-m-d H:i', (int)$u['last_active_at']);
    $kb = [
        'inline_keyboard' => [
            [['text' => '➕ Add Coins', 'callback_data' => "ma_u_add:{$targetId}"], ['text' => '➖ Deduct Coins', 'callback_data' => "ma_u_sub:{$targetId}"]],
            [['text' => $banLbl, 'callback_data' => "ma_u_ban:{$targetId}"], ['text' => '⬅️ Admin Menu', 'callback_data' => 'ma_home']],
        ],
    ];
    if ($editMsgId !== null && !$sendNew) {
        editMsg(MASTER_BOT_TOKEN, $chatId, $editMsgId, $txt, $kb);
    } else {
        sendMsg(MASTER_BOT_TOKEN, $chatId, $txt, $kb);
    }
}

function sendMasterChannelsMenu(PDO $pdo, int $chatId, ?int $editMsgId = null): void
{
    $chs = $pdo->query("SELECT * FROM master_channels ORDER BY id ASC")->fetchAll();
    $txt = "📢 <b>Master Force Join Channels (" . count($chs) . ")</b>\n\nUsers must join these channels to use the Bot Maker:";
    $rows = [];
    foreach ($chs as $c) {
        $rows[] = [
            ['text' => '📢 ' . $c['title'], 'url' => $c['invite_link']],
            ['text' => '🗑 Remove', 'callback_data' => 'ma_ch_del:' . $c['id']],
        ];
    }
    $rows[] = [['text' => '➕ Add Force Channel', 'callback_data' => 'ma_ch_add']];
    $rows[] = [['text' => '⬅️ Admin Menu', 'callback_data' => 'ma_home']];
    if ($editMsgId !== null) {
        editMsg(MASTER_BOT_TOKEN, $chatId, $editMsgId, $txt, ['inline_keyboard' => $rows]);
    } else {
        sendMsg(MASTER_BOT_TOKEN, $chatId, $txt, ['inline_keyboard' => $rows]);
    }
}

function sendMasterSettingsMenu(PDO $pdo, int $chatId, ?int $editMsgId = null): void
{
    $daily = getSetting($pdo, 'daily_coins', (string)DEFAULT_DAILY_COINS);
    $cost = getSetting($pdo, 'bot_cost', (string)DEFAULT_BOT_COST);
    $ref = getSetting($pdo, 'master_ref_coins', (string)DEFAULT_MASTER_REF_COINS);
    $sup = getSetting($pdo, 'support_username', '@Support');
    $maint = getSetting($pdo, 'maintenance', '0') === '1' ? '🔴 ON' : '🟢 OFF';

    $txt = "🪙 <b>Coins &amp; Master Bot Settings</b>\n\n" .
        "🎁 Daily Claim Coins: <code>{$daily}</code>\n" .
        "🤖 Bot Creation Cost: <code>{$cost}</code>\n" .
        "👥 Master Refer Bonus: <code>{$ref}</code>\n" .
        "🆘 Support Contact: " . esc($sup) . "\n" .
        "🛠 Maintenance Mode: <b>{$maint}</b>";

    $kb = [
        'inline_keyboard' => [
            [['text' => "🎁 Daily Coins ({$daily})", 'callback_data' => 'ma_set:daily_coins'], ['text' => "🤖 Bot Cost ({$cost})", 'callback_data' => 'ma_set:bot_cost']],
            [['text' => "👥 Refer Coins ({$ref})", 'callback_data' => 'ma_set:master_ref_coins'], ['text' => '🆘 Support @', 'callback_data' => 'ma_set:support_username']],
            [['text' => "🛠 Maintenance: {$maint}", 'callback_data' => 'ma_toggle_maint']],
            [['text' => '⬅️ Admin Menu', 'callback_data' => 'ma_home']],
        ],
    ];
    if ($editMsgId !== null) {
        editMsg(MASTER_BOT_TOKEN, $chatId, $editMsgId, $txt, $kb);
    } else {
        sendMsg(MASTER_BOT_TOKEN, $chatId, $txt, $kb);
    }
}

// ============================================================================
// 7. CHILD BOT ENGINE (UPI REFER & EARN + CHILD BOT ADMIN PANEL)
// ============================================================================
function childMainKeyboard(int $userId, int $ownerId): array
{
    $rows = [
        [['text' => '💰 Balance'], ['text' => '👥 Refer & Earn']],
        [['text' => '💸 Withdraw'], ['text' => '🏦 Set UPI ID']],
        [['text' => '🎁 Daily Bonus'], ['text' => '📜 History']],
        [['text' => '🆘 Support']],
    ];
    if ($userId === $ownerId) {
        $rows[] = [['text' => '👑 Admin Panel']];
    }
    return [
        'keyboard' => $rows,
        'resize_keyboard' => true,
        'is_persistent' => true,
    ];
}

function creditChildReferralIfEligible(PDO $pdo, array $bot, int $userId): void
{
    $botDbId = (int)$bot['id'];
    $reward = (float)$bot['per_refer'];
    $curr = (string)$bot['currency'];

    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare("SELECT referred_by, ref_credited, first_name FROM child_users WHERE bot_db_id = ? AND user_id = ?");
        $stmt->execute([$botDbId, $userId]);
        $u = $stmt->fetch();
        if (!$u || (int)$u['referred_by'] <= 0 || (int)$u['ref_credited'] === 1) {
            $pdo->commit();
            return;
        }
        $refId = (int)$u['referred_by'];
        $upd = $pdo->prepare("UPDATE child_users SET ref_credited = 1 WHERE bot_db_id = ? AND user_id = ? AND ref_credited = 0");
        $upd->execute([$botDbId, $userId]);
        if ($upd->rowCount() > 0 && $reward > 0) {
            $pdo->prepare("UPDATE child_users SET balance = balance + ?, total_earned = total_earned + ?, total_refs = total_refs + 1 WHERE bot_db_id = ? AND user_id = ?")
                ->execute([$reward, $reward, $botDbId, $refId]);
        }
        $pdo->commit();

        if ($reward > 0) {
            sendMsg(
                $bot['token'],
                $refId,
                "🎉 <b>New Verified Referral!</b>\n\n" .
                "👤 User: <b>" . esc($u['first_name']) . "</b>\n" .
                "💵 Earned: <b>+" . esc($curr) . fmtNum($reward) . "</b>"
            );
        }
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
    }
}

function handleChildUpdate(PDO $pdo, array $bot, array $update): void
{
    $token = (string)$bot['token'];
    $botDbId = (int)$bot['id'];
    $ownerId = (int)$bot['owner_id'];
    $curr = (string)$bot['currency'];

    $msg = $update['message'] ?? null;
    $cb = $update['callback_query'] ?? null;
    if (!$msg && !$cb) {
        return;
    }

    $from = $cb ? $cb['from'] : $msg['from'];
    $chatId = $cb ? (int)$cb['message']['chat']['id'] : (int)$msg['chat']['id'];
    if ($chatId <= 0) {
        return;
    }

    $userId = (int)$from['id'];
    $username = (string)($from['username'] ?? '');
    $firstName = (string)($from['first_name'] ?? 'User');
    $text = trim((string)($msg['text'] ?? ''));
    $data = trim((string)($cb['data'] ?? ''));
    $now = time();

    if ((int)$bot['is_active'] === 0) {
        if ($cb) {
            answerCb($token, $cb['id'], 'This bot is currently paused.', true);
        } else {
            sendMsg($token, $chatId, "⏸ <b>Bot Paused</b>\nThis bot is currently paused by the administrator.");
        }
        return;
    }

    $refCandidate = 0;
    if ($msg && preg_match('/^\/start(?:\s+(\d+))?/', $text, $m)) {
        if (!empty($m[1])) {
            $cand = (int)$m[1];
            if ($cand > 0 && $cand !== $userId) {
                $chk = $pdo->prepare("SELECT user_id FROM child_users WHERE bot_db_id = ? AND user_id = ?");
                $chk->execute([$botDbId, $cand]);
                if ($chk->fetchColumn()) {
                    $refCandidate = $cand;
                }
            }
        }
    }

    $stmt = $pdo->prepare("SELECT * FROM child_users WHERE bot_db_id = ? AND user_id = ?");
    $stmt->execute([$botDbId, $userId]);
    $user = $stmt->fetch();

    if (!$user) {
        $pdo->prepare("
            INSERT INTO child_users (bot_db_id, user_id, username, first_name, referred_by, joined_at, last_active_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ")->execute([$botDbId, $userId, $username, $firstName, $refCandidate, $now, $now]);
        $stmt->execute([$botDbId, $userId]);
        $user = $stmt->fetch();
    } else {
        $pdo->prepare("UPDATE child_users SET username = ?, first_name = ?, last_active_at = ? WHERE id = ?")
            ->execute([$username, $firstName, $now, $user['id']]);
        $user['username'] = $username;
        $user['first_name'] = $firstName;
    }

    if ((int)$user['is_banned'] === 1 && $userId !== $ownerId) {
        if ($cb) {
            answerCb($token, $cb['id'], 'Your account is banned.', true);
        } else {
            sendMsg($token, $chatId, "🚫 <b>Access Denied</b>\nYou are banned from using this bot.");
        }
        return;
    }

    if ((int)$bot['maintenance'] === 1 && $userId !== $ownerId) {
        if ($cb) {
            answerCb($token, $cb['id'], 'Bot is under maintenance.', true);
        } else {
            sendMsg($token, $chatId, "🛠 <b>Maintenance Mode</b>\nPlease try again shortly.");
        }
        return;
    }

    if ($userId !== $ownerId) {
        $chStmt = $pdo->prepare("SELECT * FROM child_channels WHERE bot_db_id = ? ORDER BY id ASC");
        $chStmt->execute([$botDbId]);
        $channels = $chStmt->fetchAll();
        if (!empty($channels)) {
            $unjoined = checkForceJoin($token, $channels, $userId);
            if (!empty($unjoined)) {
                if ($cb && $data === 'c_verify_join') {
                    answerCb($token, $cb['id'], 'Please join all required channels first!', true);
                    return;
                }
                if ($cb) {
                    answerCb($token, $cb['id']);
                }
                sendMsg(
                    $token,
                    $chatId,
                    "📢 <b>Join Required Channels</b>\n\nJoin all channels below to unlock earning &amp; UPI withdrawals, then tap <b>✅ I Joined / Verify</b>.",
                    buildForceJoinMarkup($unjoined, 'c_verify_join')
                );
                return;
            }
        }
    }

    if ((int)$user['referred_by'] > 0 && (int)$user['ref_credited'] === 0) {
        creditChildReferralIfEligible($pdo, $bot, $userId);
    }

    if ($cb && $data === 'c_verify_join') {
        answerCb($token, $cb['id'], 'Verified!');
        tgApi($token, 'deleteMessage', ['chat_id' => $chatId, 'message_id' => $cb['message']['message_id']]);
        sendChildHome($bot, $user, $chatId);
        return;
    }

    if ($text === '❌ Cancel' || $text === '/cancel') {
        $pdo->prepare("UPDATE child_users SET state = '', state_data = '' WHERE id = ?")->execute([$user['id']]);
        sendChildHome($bot, $user, $chatId, 'Cancelled.');
        return;
    }

    if ($cb) {
        handleChildCallback($pdo, $bot, $user, $cb);
        return;
    }

    if (($text === '/admin' || $text === '👑 Admin Panel') && $userId === $ownerId) {
        $pdo->prepare("UPDATE child_users SET state = '', state_data = '' WHERE id = ?")->execute([$user['id']]);
        sendChildAdminMenu($pdo, $bot, $chatId);
        return;
    }

    $menuCmds = ['/start', '/balance', '/refer', '/withdraw', '/upi', '/daily', '/history', '💰 Balance', '👥 Refer & Earn', '💸 Withdraw', '🏦 Set UPI ID', '🎁 Daily Bonus', '📜 History', '🆘 Support'];
    $isMenuCmd = in_array($text, $menuCmds, true) || str_starts_with($text, '/start ');

    if ($isMenuCmd) {
        if ($user['state'] !== '') {
            $pdo->prepare("UPDATE child_users SET state = '', state_data = '' WHERE id = ?")->execute([$user['id']]);
            $user['state'] = '';
            $user['state_data'] = '';
        }
    } elseif ($user['state'] !== '') {
        handleChildState($pdo, $bot, $user, $chatId, $text);
        return;
    }

    if ($text === '/start' || str_starts_with($text, '/start ')) {
        sendChildHome($bot, $user, $chatId);
    } elseif ($text === '💰 Balance' || $text === '/balance') {
        $upiShow = $user['upi_id'] !== '' ? '<code>' . esc($user['upi_id']) . '</code>' : '<i>Not Set</i>';
        $txt = "💰 <b>Your Wallet</b>\n\n" .
            "💵 <b>Balance:</b> <code>" . esc($curr) . fmtNum((float)$user['balance']) . "</code>\n" .
            "📈 <b>Total Earned:</b> <code>" . esc($curr) . fmtNum((float)$user['total_earned']) . "</code>\n" .
            "✅ <b>Total Withdrawn:</b> <code>" . esc($curr) . fmtNum((float)$user['total_withdrawn']) . "</code>\n" .
            "👥 <b>Referrals:</b> <code>{$user['total_refs']}</code>\n" .
            "🏦 <b>UPI ID:</b> {$upiShow}";
        sendMsg($token, $chatId, $txt, childMainKeyboard($userId, $ownerId));
    } elseif ($text === '👥 Refer & Earn' || $text === '/refer') {
        $link = "https://t.me/{$bot['bot_username']}?start={$userId}";
        $txt = "👥 <b>Refer &amp; Earn UPI Cash</b>\n\n" .
            "Invite friends and earn <b>" . esc($curr) . fmtNum((float)$bot['per_refer']) . "</b> per verified referral!\n\n" .
            "🔗 <b>Your Referral Link:</b>\n<code>{$link}</code>\n\n" .
            "📊 <b>Total Referrals:</b> <code>{$user['total_refs']}</code>";
        sendMsg($token, $chatId, $txt, [
            'inline_keyboard' => [
                [['text' => '📤 Share Referral Link', 'url' => 'https://t.me/share/url?url=' . urlencode($link) . '&text=' . urlencode('Earn UPI Cash by referring friends!')]],
            ],
        ]);
    } elseif ($text === '🎁 Daily Bonus' || $text === '/daily') {
        handleChildDailyBonus($pdo, $bot, $user, $chatId);
    } elseif ($text === '🏦 Set UPI ID' || $text === '/upi') {
        $pdo->prepare("UPDATE child_users SET state = 'c_await_upi' WHERE id = ?")->execute([$user['id']]);
        $cancelKb = ['keyboard' => [[['text' => '❌ Cancel']]], 'resize_keyboard' => true];
        sendMsg(
            $token,
            $chatId,
            "🏦 <b>Set Your UPI ID</b>\n\nCurrent UPI: " . ($user['upi_id'] !== '' ? '<code>' . esc($user['upi_id']) . '</code>' : '<i>None</i>') . "\n\nSend your valid UPI ID (example: <code>name@okicici</code> or <code>9876543210@ybl</code>):",
            $cancelKb
        );
    } elseif ($text === '💸 Withdraw' || $text === '/withdraw') {
        handleChildWithdrawStart($pdo, $bot, $user, $chatId);
    } elseif ($text === '📜 History' || $text === '/history') {
        $wStmt = $pdo->prepare("SELECT * FROM withdrawals WHERE bot_db_id = ? AND user_id = ? ORDER BY id DESC LIMIT 10");
        $wStmt->execute([$botDbId, $userId]);
        $wds = $wStmt->fetchAll();
        if (empty($wds)) {
            sendMsg($token, $chatId, "📜 <b>Withdrawal History</b>\n\nNo withdrawals yet.", childMainKeyboard($userId, $ownerId));
            return;
        }
        $lines = ["📜 <b>Recent Withdrawals</b>\n"];
        foreach ($wds as $w) {
            $icon = match ($w['status']) {
                'paid' => '✅ Paid',
                'rejected' => '❌ Rejected (Refunded)',
                default => '⏳ Pending',
            };
            $lines[] = "#{$w['id']} · <b>" . esc($curr) . fmtNum((float)$w['amount']) . "</b> · {$icon}\n   🏦 <code>" . esc($w['upi_id']) . "</code> · " . date('d M H:i', (int)$w['created_at']);
        }
        sendMsg($token, $chatId, implode("\n", $lines), childMainKeyboard($userId, $ownerId));
    } elseif ($text === '🆘 Support') {
        $sup = $bot['support_username'] !== '' ? $bot['support_username'] : 'Bot Owner';
        sendMsg($token, $chatId, "🆘 <b>Support</b>\n\nContact: " . esc($sup), childMainKeyboard($userId, $ownerId));
    } else {
        sendChildHome($bot, $user, $chatId);
    }
}

function sendChildHome(array $bot, array $user, int $chatId, string $prefix = ''): void
{
    $curr = (string)$bot['currency'];
    $msg = ($prefix !== '' ? "ℹ️ " . esc($prefix) . "\n\n" : '') .
        "💸 <b>Welcome to " . esc($bot['bot_name']) . "!</b>\n\n" .
        "💵 <b>Your Balance:</b> <code>" . esc($curr) . fmtNum((float)$user['balance']) . "</code>\n" .
        "👥 <b>Per Refer:</b> <code>" . esc($curr) . fmtNum((float)$bot['per_refer']) . "</code>\n" .
        "🏦 <b>Min Withdraw:</b> <code>" . esc($curr) . fmtNum((float)$bot['min_withdraw']) . "</code>\n\n" .
        "Invite friends with your referral link and withdraw directly to your <b>UPI ID</b>!";
    sendMsg($bot['token'], $chatId, $msg, childMainKeyboard((int)$user['user_id'], (int)$bot['owner_id']));
}

function handleChildDailyBonus(PDO $pdo, array $bot, array $user, int $chatId): void
{
    $bonus = (float)$bot['daily_bonus'];
    $curr = (string)$bot['currency'];
    $kb = childMainKeyboard((int)$user['user_id'], (int)$bot['owner_id']);

    if ($bonus <= 0) {
        sendMsg($bot['token'], $chatId, "🎁 Daily bonus is currently disabled in this bot.", $kb);
        return;
    }

    $now = time();
    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare("SELECT balance, last_daily_at FROM child_users WHERE id = ?");
        $stmt->execute([$user['id']]);
        $row = $stmt->fetch();
        $diff = $now - (int)$row['last_daily_at'];
        if ($diff < 86400) {
            $pdo->commit();
            sendMsg($bot['token'], $chatId, "⏳ Daily bonus already claimed! Next claim in <b>" . fmtDuration(86400 - $diff) . "</b>.", $kb);
            return;
        }
        $pdo->prepare("UPDATE child_users SET balance = balance + ?, total_earned = total_earned + ?, last_daily_at = ? WHERE id = ?")
            ->execute([$bonus, $bonus, $now, $user['id']]);
        $newBal = (float)$row['balance'] + $bonus;
        $pdo->commit();

        sendMsg(
            $bot['token'],
            $chatId,
            "🎉 <b>Daily Bonus Claimed!</b>\n\n➕ Added: <b>+" . esc($curr) . fmtNum($bonus) . "</b>\n💵 Balance: <b>" . esc($curr) . fmtNum($newBal) . "</b>",
            $kb
        );
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
    }
}

function handleChildWithdrawStart(PDO $pdo, array $bot, array $user, int $chatId): void
{
    $token = (string)$bot['token'];
    $curr = (string)$bot['currency'];
    $kb = childMainKeyboard((int)$user['user_id'], (int)$bot['owner_id']);

    if ((int)$bot['withdrawals_open'] === 0) {
        sendMsg($token, $chatId, "⏸ Withdrawals are temporarily closed by the bot admin.", $kb);
        return;
    }
    if ($user['upi_id'] === '') {
        sendMsg($token, $chatId, "🏦 Please set your <b>UPI ID</b> first using <b>🏦 Set UPI ID</b>.", $kb);
        return;
    }
    $min = (float)$bot['min_withdraw'];
    $bal = (float)$user['balance'];
    if ($bal < $min) {
        sendMsg(
            $token,
            $chatId,
            "❌ <b>Minimum Withdraw Not Reached</b>\n\n" .
            "💵 Your Balance: <code>" . esc($curr) . fmtNum($bal) . "</code>\n" .
            "🏦 Minimum Withdraw: <code>" . esc($curr) . fmtNum($min) . "</code>",
            $kb
        );
        return;
    }

    $pdo->prepare("UPDATE child_users SET state = 'c_await_wd_amt' WHERE id = ?")->execute([$user['id']]);
    sendMsg(
        $token,
        $chatId,
        "💸 <b>Withdraw to UPI</b>\n\n" .
        "🏦 UPI ID: <code>" . esc($user['upi_id']) . "</code>\n" .
        "💵 Available: <code>" . esc($curr) . fmtNum($bal) . "</code>\n" .
        "📉 Minimum: <code>" . esc($curr) . fmtNum($min) . "</code>\n\n" .
        "Enter the amount you want to withdraw, or tap below:",
        [
            'inline_keyboard' => [
                [['text' => '💯 Withdraw Full (' . $curr . fmtNum($bal) . ')', 'callback_data' => 'c_wd_full']],
            ],
        ]
    );
}

function processChildWithdraw(PDO $pdo, array $bot, array $user, int $chatId, float $amount): void
{
    $token = (string)$bot['token'];
    $botDbId = (int)$bot['id'];
    $ownerId = (int)$bot['owner_id'];
    $curr = (string)$bot['currency'];
    $min = (float)$bot['min_withdraw'];
    $kb = childMainKeyboard((int)$user['user_id'], $ownerId);

    $amount = round($amount, 2);
    if ($amount < $min) {
        sendMsg($token, $chatId, "❌ Minimum withdrawal is <b>" . esc($curr) . fmtNum($min) . "</b>.");
        return;
    }

    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare("SELECT balance, upi_id FROM child_users WHERE id = ?");
        $stmt->execute([$user['id']]);
        $fresh = $stmt->fetch();
        $bal = (float)$fresh['balance'];
        if ($amount > $bal + 0.00001 || $fresh['upi_id'] === '') {
            $pdo->commit();
            $pdo->prepare("UPDATE child_users SET state = '' WHERE id = ?")->execute([$user['id']]);
            sendMsg($token, $chatId, "❌ Insufficient balance (<code>" . esc($curr) . fmtNum($bal) . "</code>).", $kb);
            return;
        }

        $pdo->prepare("UPDATE child_users SET balance = ROUND(balance - ?, 2), state = '' WHERE id = ?")
            ->execute([$amount, $user['id']]);

        $pdo->prepare("INSERT INTO withdrawals (bot_db_id, user_id, amount, upi_id, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
            ->execute([$botDbId, (int)$user['user_id'], $amount, $fresh['upi_id'], time()]);
        $wdId = (int)$pdo->lastInsertId();
        $pdo->commit();

        sendMsg(
            $token,
            $chatId,
            "✅ <b>Withdrawal Request Submitted!</b>\n\n" .
            "🎫 Ticket: <code>#{$wdId}</code>\n" .
            "💵 Amount: <b>" . esc($curr) . fmtNum($amount) . "</b>\n" .
            "🏦 UPI ID: <code>" . esc($fresh['upi_id']) . "</code>\n" .
            "📌 Status: <b>⏳ Pending Approval</b>",
            $kb
        );

        $adminMsg = "🔔 <b>New Withdrawal Request #{$wdId}</b>\n\n" .
            "👤 User: <b>" . esc($user['first_name']) . "</b> (<code>{$user['user_id']}</code>)\n" .
            "💵 Amount: <b>" . esc($curr) . fmtNum($amount) . "</b>\n" .
            "🏦 UPI ID: <code>" . esc($fresh['upi_id']) . "</code>";
        sendMsg($token, $ownerId, $adminMsg, [
            'inline_keyboard' => [
                [
                    ['text' => '✅ Approve (Paid)', 'callback_data' => "ca_wd_ok:{$wdId}"],
                    ['text' => '❌ Reject (Refund)', 'callback_data' => "ca_wd_no:{$wdId}"],
                ],
            ],
        ]);
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        sendMsg($token, $chatId, "⚠️ Error submitting withdrawal. Try again.", $kb);
    }
}

function handleChildState(PDO $pdo, array $bot, array $user, int $chatId, string $text): void
{
    $token = (string)$bot['token'];
    $botDbId = (int)$bot['id'];
    $ownerId = (int)$bot['owner_id'];
    $userId = (int)$user['user_id'];
    $state = (string)$user['state'];
    $stateData = json_decode((string)$user['state_data'], true) ?: [];

    if ($state === 'c_await_upi') {
        $upi = trim($text);
        if (!preg_match('/^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/', $upi)) {
            sendMsg($token, $chatId, "❌ Invalid UPI ID format. Example: <code>username@okaxis</code> or <code>9876543210@paytm</code>");
            return;
        }
        $pdo->prepare("UPDATE child_users SET upi_id = ?, state = '' WHERE id = ?")->execute([$upi, $user['id']]);
        sendMsg($token, $chatId, "✅ UPI ID saved: <code>" . esc($upi) . "</code>", childMainKeyboard($userId, $ownerId));
        return;
    }

    if ($state === 'c_await_wd_amt') {
        if (!is_numeric($text) || (float)$text <= 0) {
            sendMsg($token, $chatId, "❌ Please enter a valid numeric amount (or /cancel).");
            return;
        }
        processChildWithdraw($pdo, $bot, $user, $chatId, (float)$text);
        return;
    }

    if ($userId !== $ownerId) {
        $pdo->prepare("UPDATE child_users SET state = '' WHERE id = ?")->execute([$user['id']]);
        sendChildHome($bot, $user, $chatId);
        return;
    }

    if ($state === 'ca_find_user') {
        $q = ltrim(trim($text), '@');
        $stmt = ctype_digit($q)
            ? $pdo->prepare("SELECT * FROM child_users WHERE bot_db_id = ? AND user_id = ?")
            : $pdo->prepare("SELECT * FROM child_users WHERE bot_db_id = ? AND LOWER(username) = LOWER(?)");
        $stmt->execute([$botDbId, $q]);
        $target = $stmt->fetch();
        $pdo->prepare("UPDATE child_users SET state = '' WHERE id = ?")->execute([$user['id']]);
        if (!$target) {
            sendMsg($token, $chatId, "❌ User not found in this bot.");
            return;
        }
        sendChildAdminUserCard($pdo, $bot, $chatId, (int)$target['user_id']);
        return;
    }

    if ($state === 'ca_add_bal' || $state === 'ca_sub_bal') {
        $tid = (int)($stateData['target_id'] ?? 0);
        if (!is_numeric($text) || (float)$text <= 0) {
            sendMsg($token, $chatId, "❌ Enter a valid positive amount.");
            return;
        }
        $amt = round((float)$text, 2);
        $pdo->prepare("UPDATE child_users SET state = '', state_data = '' WHERE id = ?")->execute([$user['id']]);
        if ($state === 'ca_add_bal') {
            $pdo->prepare("UPDATE child_users SET balance = ROUND(balance + ?, 2), total_earned = ROUND(total_earned + ?, 2) WHERE bot_db_id = ? AND user_id = ?")
                ->execute([$amt, $amt, $botDbId, $tid]);
            sendMsg($token, $tid, "💵 Admin added <b>+" . esc($bot['currency']) . fmtNum($amt) . "</b> to your balance!");
        } else {
            $pdo->prepare("UPDATE child_users SET balance = MAX(0, ROUND(balance - ?, 2)) WHERE bot_db_id = ? AND user_id = ?")
                ->execute([$amt, $botDbId, $tid]);
        }
        sendChildAdminUserCard($pdo, $bot, $chatId, $tid, true);
        return;
    }

    if ($state === 'ca_add_channel') {
        $res = resolveChannelInput($token, $text);
        if (!$res['ok']) {
            sendMsg($token, $chatId, "❌ " . $res['error']);
            return;
        }
        $pdo->prepare("UPDATE child_users SET state = '' WHERE id = ?")->execute([$user['id']]);
        $pdo->prepare("INSERT INTO child_channels (bot_db_id, chat_id, title, invite_link, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(bot_db_id, chat_id) DO UPDATE SET title = excluded.title, invite_link = excluded.invite_link")
            ->execute([$botDbId, $res['chat_id'], $res['title'], $res['invite_link'], time()]);
        sendMsg($token, $chatId, "✅ Force channel added: <b>" . esc($res['title']) . "</b>");
        sendChildChannelsMenu($pdo, $bot, $chatId);
        return;
    }

    if (str_starts_with($state, 'ca_set:')) {
        $field = substr($state, 7);
        $val = trim($text);
        if (in_array($field, ['per_refer', 'min_withdraw', 'daily_bonus'], true)) {
            if (!is_numeric($val) || (float)$val < 0) {
                sendMsg($token, $chatId, "❌ Enter a valid non-negative number.");
                return;
            }
            $pdo->prepare("UPDATE bots SET {$field} = ? WHERE id = ?")->execute([round((float)$val, 2), $botDbId]);
        } elseif ($field === 'support_username') {
            $pdo->prepare("UPDATE bots SET {$field} = ? WHERE id = ?")->execute([$val, $botDbId]);
        }
        $pdo->prepare("UPDATE child_users SET state = '' WHERE id = ?")->execute([$user['id']]);
        $stmt = $pdo->prepare("SELECT * FROM bots WHERE id = ?");
        $stmt->execute([$botDbId]);
        $freshBot = $stmt->fetch();
        sendMsg($token, $chatId, "✅ Updated <b>" . esc($field) . "</b>.");
        sendChildSettingsMenu($freshBot, $chatId);
        return;
    }

    if ($state === 'ca_bc_msg') {
        $pdo->prepare("UPDATE child_users SET state = 'ca_bc_btn', state_data = ? WHERE id = ?")
            ->execute([json_encode(['msg' => $text]), $user['id']]);
        sendMsg($token, $chatId, "🔘 Optional button: send <code>Label | https://url.com</code> or send <code>skip</code>:");
        return;
    }

    if ($state === 'ca_bc_btn') {
        $btn = null;
        if (strtolower($text) !== 'skip') {
            if (strpos($text, '|') === false) {
                sendMsg($token, $chatId, "❌ Invalid format. Use <code>Label | https://url.com</code> or <code>skip</code>.");
                return;
            }
            [$lbl, $url] = array_map('trim', explode('|', $text, 2));
            if (!filter_var($url, FILTER_VALIDATE_URL)) {
                sendMsg($token, $chatId, "❌ Invalid URL.");
                return;
            }
            $btn = ['text' => $lbl, 'url' => $url];
        }
        $stateData['btn'] = $btn;
        $pdo->prepare("UPDATE child_users SET state = '', state_data = ? WHERE id = ?")
            ->execute([json_encode($stateData), $user['id']]);
        sendMsg($token, $chatId, "📋 <b>Broadcast Preview</b>\n\n" . $stateData['msg'], [
            'inline_keyboard' => [
                [['text' => '✅ Send to All Users', 'callback_data' => 'ca_bc_exec']],
                [['text' => '❌ Cancel', 'callback_data' => 'ca_home']],
            ],
        ]);
        return;
    }
}

function handleChildCallback(PDO $pdo, array $bot, array $user, array $cb): void
{
    $token = (string)$bot['token'];
    $botDbId = (int)$bot['id'];
    $ownerId = (int)$bot['owner_id'];
    $userId = (int)$user['user_id'];
    $chatId = (int)$cb['message']['chat']['id'];
    $msgId = (int)$cb['message']['message_id'];
    $data = (string)$cb['data'];
    $curr = (string)$bot['currency'];

    if ($data === 'c_wd_full') {
        answerCb($token, $cb['id']);
        tgApi($token, 'deleteMessage', ['chat_id' => $chatId, 'message_id' => $msgId]);
        processChildWithdraw($pdo, $bot, $user, $chatId, (float)$user['balance']);
        return;
    }

    if ($userId !== $ownerId) {
        answerCb($token, $cb['id'], 'Admin only.', true);
        return;
    }

    if ($data === 'ca_home') {
        $pdo->prepare("UPDATE child_users SET state = '', state_data = '' WHERE id = ?")->execute([$user['id']]);
        answerCb($token, $cb['id']);
        sendChildAdminMenu($pdo, $bot, $chatId, $msgId);
        return;
    }

    if ($data === 'ca_stats') {
        answerCb($token, $cb['id']);
        $now = time();
        $uTotal = (int)$pdo->query("SELECT COUNT(*) FROM child_users WHERE bot_db_id = {$botDbId}")->fetchColumn();
        $uActive = (int)$pdo->query("SELECT COUNT(*) FROM child_users WHERE bot_db_id = {$botDbId} AND last_active_at >= " . ($now - 86400))->fetchColumn();
        $balSum = (float)$pdo->query("SELECT COALESCE(SUM(balance),0) FROM child_users WHERE bot_db_id = {$botDbId}")->fetchColumn();
        $paidSum = (float)$pdo->query("SELECT COALESCE(SUM(amount),0) FROM withdrawals WHERE bot_db_id = {$botDbId} AND status = 'paid'")->fetchColumn();
        $pendCnt = (int)$pdo->query("SELECT COUNT(*) FROM withdrawals WHERE bot_db_id = {$botDbId} AND status = 'pending'")->fetchColumn();

        $txt = "📊 <b>Bot Status &amp; Analytics</b>\n\n" .
            "👥 <b>Total Users:</b> <code>{$uTotal}</code>\n" .
            "🟢 <b>Active (24h):</b> <code>{$uActive}</code>\n" .
            "💵 <b>Unclaimed User Wallets:</b> <code>" . esc($curr) . fmtNum($balSum) . "</code>\n" .
            "✅ <b>Total Paid Out:</b> <code>" . esc($curr) . fmtNum($paidSum) . "</code>\n" .
            "⏳ <b>Pending Withdrawals:</b> <code>{$pendCnt}</code>";
        editMsg($token, $chatId, $msgId, $txt, [
            'inline_keyboard' => [
                [['text' => '🔄 Refresh', 'callback_data' => 'ca_stats'], ['text' => '💸 Pending Queue', 'callback_data' => 'ca_wds:0']],
                [['text' => '⬅️ Admin Menu', 'callback_data' => 'ca_home']],
            ],
        ]);
        return;
    }

    if (str_starts_with($data, 'ca_wds:')) {
        answerCb($token, $cb['id']);
        $offset = max(0, (int)substr($data, 7));
        $stmt = $pdo->prepare("
            SELECT w.*, cu.first_name, cu.username
            FROM withdrawals w
            LEFT JOIN child_users cu ON cu.bot_db_id = w.bot_db_id AND cu.user_id = w.user_id
            WHERE w.bot_db_id = ? AND w.status = 'pending'
            ORDER BY w.id ASC LIMIT 1 OFFSET ?
        ");
        $stmt->execute([$botDbId, $offset]);
        $w = $stmt->fetch();

        $totalPend = (int)$pdo->query("SELECT COUNT(*) FROM withdrawals WHERE bot_db_id = {$botDbId} AND status = 'pending'")->fetchColumn();
        if (!$w) {
            editMsg($token, $chatId, $msgId, "💸 <b>Pending Withdrawals</b>\n\n🎉 All caught up! No pending withdrawal requests.", [
                'inline_keyboard' => [[['text' => '⬅️ Admin Menu', 'callback_data' => 'ca_home']]],
            ]);
            return;
        }
        $uname = !empty($w['username']) ? '@' . esc($w['username']) : esc($w['first_name'] ?? 'User');
        $txt = "💸 <b>Pending Withdrawal (" . ($offset + 1) . "/{$totalPend})</b>\n\n" .
            "🎫 Ticket: <code>#{$w['id']}</code>\n" .
            "👤 User: <b>{$uname}</b> (<code>{$w['user_id']}</code>)\n" .
            "💵 Amount: <b>" . esc($curr) . fmtNum((float)$w['amount']) . "</b>\n" .
            "🏦 UPI ID: <code>" . esc($w['upi_id']) . "</code>\n" .
            "🕒 Requested: " . date('Y-m-d H:i', (int)$w['created_at']);

        $kb = [
            'inline_keyboard' => [
                [
                    ['text' => '✅ Approve (Paid)', 'callback_data' => "ca_wd_ok:{$w['id']}"],
                    ['text' => '❌ Reject (Refund)', 'callback_data' => "ca_wd_no:{$w['id']}"],
                ],
            ],
        ];
        $nav = [];
        if ($offset > 0) {
            $nav[] = ['text' => '⬅️ Prev', 'callback_data' => 'ca_wds:' . ($offset - 1)];
        }
        if ($offset + 1 < $totalPend) {
            $nav[] = ['text' => 'Next ➡️', 'callback_data' => 'ca_wds:' . ($offset + 1)];
        }
        if (!empty($nav)) {
            $kb['inline_keyboard'][] = $nav;
        }
        $kb['inline_keyboard'][] = [['text' => '⬅️ Admin Menu', 'callback_data' => 'ca_home']];
        editMsg($token, $chatId, $msgId, $txt, $kb);
        return;
    }

    if (str_starts_with($data, 'ca_wd_ok:') || str_starts_with($data, 'ca_wd_no:')) {
        $isApprove = str_starts_with($data, 'ca_wd_ok:');
        $wdId = (int)substr($data, 9);

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare("SELECT * FROM withdrawals WHERE id = ? AND bot_db_id = ?");
            $stmt->execute([$wdId, $botDbId]);
            $w = $stmt->fetch();
            if (!$w || $w['status'] !== 'pending') {
                $pdo->commit();
                answerCb($token, $cb['id'], 'Already processed.', true);
                return;
            }
            $newStatus = $isApprove ? 'paid' : 'rejected';
            $pdo->prepare("UPDATE withdrawals SET status = ?, processed_at = ? WHERE id = ?")
                ->execute([$newStatus, time(), $wdId]);

            if ($isApprove) {
                $pdo->prepare("UPDATE child_users SET total_withdrawn = ROUND(total_withdrawn + ?, 2) WHERE bot_db_id = ? AND user_id = ?")
                    ->execute([$w['amount'], $botDbId, $w['user_id']]);
            } else {
                $pdo->prepare("UPDATE child_users SET balance = ROUND(balance + ?, 2) WHERE bot_db_id = ? AND user_id = ?")
                    ->execute([$w['amount'], $botDbId, $w['user_id']]);
            }
            $pdo->commit();

            answerCb($token, $cb['id'], $isApprove ? 'Marked as Paid!' : 'Rejected & Refunded!');
            $badge = $isApprove ? '✅ Approved &amp; Paid' : '❌ Rejected (Refunded)';
            editMsg(
                $token,
                $chatId,
                $msgId,
                "🎫 <b>Withdrawal #{$wdId}</b>\n💵 Amount: <b>" . esc($curr) . fmtNum((float)$w['amount']) . "</b>\n🏦 UPI: <code>" . esc($w['upi_id']) . "</code>\n\nResult: <b>{$badge}</b>",
                ['inline_keyboard' => [[['text' => '💸 Next Pending', 'callback_data' => 'ca_wds:0'], ['text' => '⬅️ Admin Menu', 'callback_data' => 'ca_home']]]]
            );

            $userNotice = $isApprove
                ? "✅ <b>Withdrawal Approved!</b>\n\n🎫 Ticket: <code>#{$wdId}</code>\n💵 Amount: <b>" . esc($curr) . fmtNum((float)$w['amount']) . "</b>\n🏦 Sent to UPI: <code>" . esc($w['upi_id']) . "</code>"
                : "❌ <b>Withdrawal Rejected</b>\n\n🎫 Ticket: <code>#{$wdId}</code>\n💵 <b>" . esc($curr) . fmtNum((float)$w['amount']) . "</b> has been refunded to your bot wallet.";
            sendMsg($token, (int)$w['user_id'], $userNotice);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            answerCb($token, $cb['id'], 'Error updating withdrawal.', true);
        }
        return;
    }

    if ($data === 'ca_find_user') {
        answerCb($token, $cb['id']);
        $pdo->prepare("UPDATE child_users SET state = 'ca_find_user' WHERE id = ?")->execute([$user['id']]);
        sendMsg($token, $chatId, "🔍 Enter User ID or @username (or /cancel):");
        return;
    }

    if (str_starts_with($data, 'ca_u_add:') || str_starts_with($data, 'ca_u_sub:')) {
        answerCb($token, $cb['id']);
        $isAdd = str_starts_with($data, 'ca_u_add:');
        $tid = (int)substr($data, 9);
        $pdo->prepare("UPDATE child_users SET state = ?, state_data = ? WHERE id = ?")
            ->execute([$isAdd ? 'ca_add_bal' : 'ca_sub_bal', json_encode(['target_id' => $tid]), $user['id']]);
        sendMsg($token, $chatId, ($isAdd ? "➕" : "➖") . " Enter amount (" . esc($curr) . ") for user <code>{$tid}</code>:");
        return;
    }

    if (str_starts_with($data, 'ca_u_ban:')) {
        $tid = (int)substr($data, 9);
        $pdo->prepare("UPDATE child_users SET is_banned = CASE WHEN is_banned = 1 THEN 0 ELSE 1 END WHERE bot_db_id = ? AND user_id = ?")
            ->execute([$botDbId, $tid]);
        answerCb($token, $cb['id'], 'User status updated.');
        sendChildAdminUserCard($pdo, $bot, $chatId, $tid, false, $msgId);
        return;
    }

    if ($data === 'ca_channels') {
        answerCb($token, $cb['id']);
        sendChildChannelsMenu($pdo, $bot, $chatId, $msgId);
        return;
    }

    if ($data === 'ca_ch_add') {
        answerCb($token, $cb['id']);
        $pdo->prepare("UPDATE child_users SET state = 'ca_add_channel' WHERE id = ?")->execute([$user['id']]);
        sendMsg($token, $chatId, "📢 Make this bot Admin in your channel first, then send <code>@ChannelUsername</code> or <code>-100ID | https://t.me/+InviteLink</code>:");
        return;
    }

    if (str_starts_with($data, 'ca_ch_del:')) {
        $cid = (int)substr($data, 10);
        $pdo->prepare("DELETE FROM child_channels WHERE id = ? AND bot_db_id = ?")->execute([$cid, $botDbId]);
        answerCb($token, $cb['id'], 'Channel removed.');
        sendChildChannelsMenu($pdo, $bot, $chatId, $msgId);
        return;
    }

    if ($data === 'ca_settings') {
        answerCb($token, $cb['id']);
        sendChildSettingsMenu($bot, $chatId, $msgId);
        return;
    }

    if (str_starts_with($data, 'ca_set:')) {
        $field = substr($data, 7);
        if (!in_array($field, ['per_refer', 'min_withdraw', 'daily_bonus', 'support_username'], true)) {
            answerCb($token, $cb['id'], 'Option disabled.', true);
            return;
        }
        answerCb($token, $cb['id']);
        $pdo->prepare("UPDATE child_users SET state = ? WHERE id = ?")->execute(['ca_set:' . $field, $user['id']]);
        sendMsg($token, $chatId, "✏️ Enter new value for <b>" . esc($field) . "</b> (or /cancel):");
        return;
    }

    if (str_starts_with($data, 'ca_tog:')) {
        $field = substr($data, 7);
        if (in_array($field, ['withdrawals_open', 'maintenance'], true)) {
            $pdo->prepare("UPDATE bots SET {$field} = CASE WHEN {$field} = 1 THEN 0 ELSE 1 END WHERE id = ?")->execute([$botDbId]);
            $stmt = $pdo->prepare("SELECT * FROM bots WHERE id = ?");
            $stmt->execute([$botDbId]);
            $fresh = $stmt->fetch();
            answerCb($token, $cb['id'], 'Setting updated.');
            sendChildSettingsMenu($fresh, $chatId, $msgId);
        }
        return;
    }

    if ($data === 'ca_broadcast') {
        answerCb($token, $cb['id']);
        $pdo->prepare("UPDATE child_users SET state = 'ca_bc_msg' WHERE id = ?")->execute([$user['id']]);
        sendMsg($token, $chatId, "📣 <b>Broadcast to Your Bot Users</b>\n\nSend the message to deliver to all users of @" . esc($bot['bot_username']) . " (HTML supported):");
        return;
    }

    if ($data === 'ca_bc_exec') {
        $sd = json_decode((string)$user['state_data'], true);
        if (!$sd || empty($sd['msg'])) {
            answerCb($token, $cb['id'], 'No pending broadcast.', true);
            return;
        }
        answerCb($token, $cb['id'], 'Broadcasting...');
        $pdo->prepare("UPDATE child_users SET state_data = '' WHERE id = ?")->execute([$user['id']]);
        $markup = !empty($sd['btn']) ? ['inline_keyboard' => [[$sd['btn']]]] : null;
        editMsg($token, $chatId, $msgId, "⏳ <b>Broadcasting to your bot users...</b>");
        $uids = $pdo->query("SELECT user_id FROM child_users WHERE bot_db_id = {$botDbId} AND is_banned = 0")->fetchAll(PDO::FETCH_COLUMN);
        $res = executeBroadcast($token, $uids, $sd['msg'], $markup);
        sendMsg($token, $chatId, "✅ <b>Broadcast Complete</b>\n\n📤 Sent: <code>{$res['sent']}</code>\n❌ Failed/Blocked: <code>{$res['failed']}</code>");
        return;
    }
}

function sendChildAdminMenu(PDO $pdo, array $bot, int $chatId, ?int $editMsgId = null): void
{
    $botDbId = (int)$bot['id'];
    $curr = (string)$bot['currency'];
    $pend = (int)$pdo->query("SELECT COUNT(*) FROM withdrawals WHERE bot_db_id = {$botDbId} AND status = 'pending'")->fetchColumn();
    $users = (int)$pdo->query("SELECT COUNT(*) FROM child_users WHERE bot_db_id = {$botDbId}")->fetchColumn();

    $txt = "👑 <b>Child Bot Admin Panel</b>\n" .
        "🤖 @" . esc($bot['bot_username']) . "\n\n" .
        "👥 Users: <code>{$users}</code> · ⏳ Pending Withdrawals: <code>{$pend}</code>\n" .
        "💵 Per Refer: <code>" . esc($curr) . fmtNum((float)$bot['per_refer']) . "</code> · 🏦 Min Withdraw: <code>" . esc($curr) . fmtNum((float)$bot['min_withdraw']) . "</code>";

    $kb = [
        'inline_keyboard' => [
            [['text' => "💸 Withdrawals ({$pend})", 'callback_data' => 'ca_wds:0'], ['text' => '📊 Bot Status', 'callback_data' => 'ca_stats']],
            [['text' => '🔍 Find User', 'callback_data' => 'ca_find_user'], ['text' => '📢 Force Channels', 'callback_data' => 'ca_channels']],
            [['text' => '📣 Broadcast', 'callback_data' => 'ca_broadcast'], ['text' => '⚙️ Bot Settings', 'callback_data' => 'ca_settings']],
        ],
    ];
    if ($editMsgId !== null) {
        editMsg($bot['token'], $chatId, $editMsgId, $txt, $kb);
    } else {
        sendMsg($bot['token'], $chatId, $txt, $kb);
    }
}

function sendChildAdminUserCard(PDO $pdo, array $bot, int $chatId, int $targetId, bool $sendNew = false, ?int $editMsgId = null): void
{
    $stmt = $pdo->prepare("SELECT * FROM child_users WHERE bot_db_id = ? AND user_id = ?");
    $stmt->execute([(int)$bot['id'], $targetId]);
    $u = $stmt->fetch();
    if (!$u) {
        return;
    }
    $curr = (string)$bot['currency'];
    $st = (int)$u['is_banned'] === 1 ? '🚫 Banned' : '🟢 Active';
    $banLbl = (int)$u['is_banned'] === 1 ? '✅ Unban' : '🚫 Ban';
    $txt = "👤 <b>Bot User</b>\n\n" .
        "ID: <code>{$u['user_id']}</code>\n" .
        "Name: <b>" . esc($u['first_name']) . "</b>\n" .
        "Balance: <code>" . esc($curr) . fmtNum((float)$u['balance']) . "</code>\n" .
        "UPI ID: <code>" . esc($u['upi_id'] !== '' ? $u['upi_id'] : 'None') . "</code>\n" .
        "Referrals: <code>{$u['total_refs']}</code>\n" .
        "Status: <b>{$st}</b>";
    $kb = [
        'inline_keyboard' => [
            [['text' => '➕ Add Balance', 'callback_data' => "ca_u_add:{$targetId}"], ['text' => '➖ Deduct Balance', 'callback_data' => "ca_u_sub:{$targetId}"]],
            [['text' => $banLbl, 'callback_data' => "ca_u_ban:{$targetId}"], ['text' => '⬅️ Admin Menu', 'callback_data' => 'ca_home']],
        ],
    ];
    if ($editMsgId !== null && !$sendNew) {
        editMsg($bot['token'], $chatId, $editMsgId, $txt, $kb);
    } else {
        sendMsg($bot['token'], $chatId, $txt, $kb);
    }
}

function sendChildChannelsMenu(PDO $pdo, array $bot, int $chatId, ?int $editMsgId = null): void
{
    $stmt = $pdo->prepare("SELECT * FROM child_channels WHERE bot_db_id = ? ORDER BY id ASC");
    $stmt->execute([(int)$bot['id']]);
    $chs = $stmt->fetchAll();

    $txt = "📢 <b>Bot Force Join Channels (" . count($chs) . ")</b>\n\nUsers must join these channels to earn &amp; withdraw:";
    $rows = [];
    foreach ($chs as $c) {
        $rows[] = [
            ['text' => '📢 ' . $c['title'], 'url' => $c['invite_link']],
            ['text' => '🗑 Remove', 'callback_data' => 'ca_ch_del:' . $c['id']],
        ];
    }
    $rows[] = [['text' => '➕ Add Force Channel', 'callback_data' => 'ca_ch_add']];
    $rows[] = [['text' => '⬅️ Admin Menu', 'callback_data' => 'ca_home']];

    if ($editMsgId !== null) {
        editMsg($bot['token'], $chatId, $editMsgId, $txt, ['inline_keyboard' => $rows]);
    } else {
        sendMsg($bot['token'], $chatId, $txt, ['inline_keyboard' => $rows]);
    }
}

function sendChildSettingsMenu(array $bot, int $chatId, ?int $editMsgId = null): void
{
    $curr = (string)$bot['currency'];
    $wdOpen = (int)$bot['withdrawals_open'] === 1 ? '🟢 Open' : '🔴 Closed';
    $maint = (int)$bot['maintenance'] === 1 ? '🔴 ON' : '🟢 OFF';
    $txt = "⚙️ <b>Rewards &amp; Bot Settings (INR)</b>\n\n" .
        "🎁 Daily Bonus: <code>" . esc($curr) . fmtNum((float)$bot['daily_bonus']) . "</code>\n" .
        "👥 Per Refer Reward: <code>" . esc($curr) . fmtNum((float)$bot['per_refer']) . "</code>\n" .
        "🏦 Min Withdraw: <code>" . esc($curr) . fmtNum((float)$bot['min_withdraw']) . "</code>\n" .
        "🆘 Support: " . esc($bot['support_username'] ?: 'Not Set') . "\n" .
        "💸 Withdrawals: <b>{$wdOpen}</b>\n" .
        "🛠 Maintenance: <b>{$maint}</b>";

    $kb = [
        'inline_keyboard' => [
            [['text' => '👥 Per Refer (' . $curr . fmtNum((float)$bot['per_refer']) . ')', 'callback_data' => 'ca_set:per_refer'], ['text' => '🏦 Min Withdraw (' . $curr . fmtNum((float)$bot['min_withdraw']) . ')', 'callback_data' => 'ca_set:min_withdraw']],
            [['text' => '🎁 Daily Bonus (' . $curr . fmtNum((float)$bot['daily_bonus']) . ')', 'callback_data' => 'ca_set:daily_bonus'], ['text' => '🆘 Support @', 'callback_data' => 'ca_set:support_username']],
            [['text' => "💸 Withdraw: {$wdOpen}", 'callback_data' => 'ca_tog:withdrawals_open'], ['text' => "🛠 Maintenance: {$maint}", 'callback_data' => 'ca_tog:maintenance']],
            [['text' => '⬅️ Admin Menu', 'callback_data' => 'ca_home']],
        ],
    ];
    if ($editMsgId !== null) {
        editMsg($bot['token'], $chatId, $editMsgId, $txt, $kb);
    } else {
        sendMsg($bot['token'], $chatId, $txt, $kb);
    }
}
