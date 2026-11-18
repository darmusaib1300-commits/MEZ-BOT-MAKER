import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, Download, ExternalLink, RefreshCw } from 'lucide-react';
import { BotConfig, DEFAULT_BOT_CONFIG, generateBotPhp } from './data/botPhpTemplate';
import { CodeViewer } from './components/CodeViewer';
import { BotFlowPreview } from './components/BotFlowPreview';

type TabView = 'live' | 'code' | 'flows' | 'deploy';

interface LiveStatusResponse {
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

function formatBotType(type: string): string {
  switch (type) {
    case 'upi_advanced':
      return 'UPI Adv';
    case 'redeem_normal':
      return 'Redeem';
    case 'redeem_advanced':
      return 'Redeem Adv';
    case 'star_normal':
      return 'Star Normal';
    case 'star_advanced':
      return 'Star Adv';
    case 'gmail_bot':
      return 'Gmail Bot';
    default:
      return 'UPI Normal';
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabView>('live');
  const [config, setConfig] = useState<BotConfig>(DEFAULT_BOT_CONFIG);
  const [copiedSetupUrl, setCopiedSetupUrl] = useState(false);

  const [liveStatus, setLiveStatus] = useState<LiveStatusResponse | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  const [dailyCoinsInput, setDailyCoinsInput] = useState(2);
  const [costUpiNormalInput, setCostUpiNormalInput] = useState(5);
  const [costUpiAdvancedInput, setCostUpiAdvancedInput] = useState(10);
  const [costRedeemNormalInput, setCostRedeemNormalInput] = useState(5);
  const [costRedeemAdvancedInput, setCostRedeemAdvancedInput] = useState(10);
  const [costStarNormalInput, setCostStarNormalInput] = useState(5);
  const [costStarAdvancedInput, setCostStarAdvancedInput] = useState(10);
  const [costGmailBotInput, setCostGmailBotInput] = useState(10);
  const [refCoinsInput, setRefCoinsInput] = useState(1);
  const [depositEnabledInput, setDepositEnabledInput] = useState(true);
  const [depositRsInput, setDepositRsInput] = useState(10);
  const [depositCoinsInput, setDepositCoinsInput] = useState(5);
  const [minDepositRsInput, setMinDepositRsInput] = useState(10);
  const [depositUpiInput, setDepositUpiInput] = useState('');
  const [deviceVerifyInput, setDeviceVerifyInput] = useState(true);
  const [verifyBaseUrlInput, setVerifyBaseUrlInput] = useState('');
  const [supportInput, setSupportInput] = useState('@Support');
  const [maintenanceInput, setMaintenanceInput] = useState(false);

  const fetchStatus = useCallback(async (syncInputs = false) => {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) return;
      const data = (await res.json()) as LiveStatusResponse;
      setLiveStatus(data);
      if (syncInputs) {
        setDailyCoinsInput(data.settings.dailyCoins);
        setCostUpiNormalInput(data.settings.costUpiNormal);
        setCostUpiAdvancedInput(data.settings.costUpiAdvanced);
        setCostRedeemNormalInput(data.settings.costRedeemNormal);
        setCostRedeemAdvancedInput(data.settings.costRedeemAdvanced);
        setCostStarNormalInput(data.settings.costStarNormal);
        setCostStarAdvancedInput(data.settings.costStarAdvanced);
        setCostGmailBotInput(data.settings.costGmailBot);
        setRefCoinsInput(data.settings.masterRefCoins);
        setDepositEnabledInput(data.settings.depositEnabled);
        setDepositRsInput(data.settings.depositRs);
        setDepositCoinsInput(data.settings.depositCoins);
        setMinDepositRsInput(data.settings.minDepositRs);
        setDepositUpiInput(data.settings.depositUpiId);
        setDeviceVerifyInput(data.settings.deviceVerify);
        setVerifyBaseUrlInput(data.verifyBaseUrl);
        setSupportInput(data.settings.supportUsername);
        setMaintenanceInput(data.settings.maintenance);
      }
    } catch {
      // ignore transient network errors
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus(true);
    const id = setInterval(() => {
      void fetchStatus(false);
    }, 6000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  const generatedPhp = useMemo(() => generateBotPhp(config), [config]);

  const setupUrl = useMemo(() => {
    const base = config.webhookBaseUrl.trim().replace(/\/+$/, '') || 'https://yourdomain.com/bot.php';
    return `${base}?setup=1&key=${encodeURIComponent(config.setupSecret)}`;
  }, [config.webhookBaseUrl, config.setupSecret]);

  const handleDownloadPhp = () => {
    const blob = new Blob([generatedPhp], { type: 'application/x-httpd-php;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bot.php';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleSaveLiveSettings = async () => {
    setSavingSettings(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dailyCoins: dailyCoinsInput,
          costUpiNormal: costUpiNormalInput,
          costUpiAdvanced: costUpiAdvancedInput,
          costRedeemNormal: costRedeemNormalInput,
          costRedeemAdvanced: costRedeemAdvancedInput,
          costStarNormal: costStarNormalInput,
          costStarAdvanced: costStarAdvancedInput,
          costGmailBot: costGmailBotInput,
          masterRefCoins: refCoinsInput,
          depositEnabled: depositEnabledInput,
          depositRs: depositRsInput,
          depositCoins: depositCoinsInput,
          minDepositRs: minDepositRsInput,
          depositUpiId: depositUpiInput,
          deviceVerify: deviceVerifyInput,
          verifyBaseUrl: verifyBaseUrlInput,
          supportUsername: supportInput,
          maintenance: maintenanceInput,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { status: LiveStatusResponse };
        setLiveStatus(data.status);
        setSavedNotice(true);
        setTimeout(() => setSavedNotice(false), 1800);
      }
    } finally {
      setSavingSettings(false);
    }
  };

  const handleRestartBot = async () => {
    const res = await fetch('/api/bot/restart', { method: 'POST' });
    if (res.ok) {
      const data = (await res.json()) as { status: LiveStatusResponse };
      setLiveStatus(data.status);
    }
  };

  const handleRandomSecret = () => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = 'tf_';
    for (let i = 0; i < 18; i++) {
      out += chars[Math.floor(Math.random() * chars.length)];
    }
    setConfig((prev) => ({ ...prev, setupSecret: out }));
  };

  const handleCopySetupUrl = async () => {
    await navigator.clipboard.writeText(setupUrl);
    setCopiedSetupUrl(true);
    setTimeout(() => setCopiedSetupUrl(false), 1800);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      <div className="h-1 w-full bg-gradient-to-r from-blue-600 via-indigo-500 to-emerald-500" />
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-6 py-3.5 flex items-center justify-between gap-8">
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('live');
            }}
            className="text-lg font-bold tracking-tight bg-gradient-to-r from-blue-700 via-indigo-600 to-emerald-600 bg-clip-text text-transparent whitespace-nowrap shrink-0"
          >
            TeleFactory
          </a>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            {(
              [
                { id: 'live', label: 'Live Bot' },
                { id: 'code', label: 'bot.php Code' },
                { id: 'flows', label: 'Bot Flows' },
                { id: 'deploy', label: 'Deploy Guide' },
              ] as const
            ).map((nav) => (
              <button
                key={nav.id}
                type="button"
                onClick={() => setActiveTab(nav.id)}
                className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer border-b-2 ${
                  activeTab === nav.id
                    ? 'text-indigo-700 border-indigo-600'
                    : 'border-transparent hover:text-slate-900'
                }`}
              >
                {nav.label}
              </button>
            ))}
          </nav>

          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={handleDownloadPhp}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              Download bot.php
            </button>
          </div>
        </div>

        {/* Mobile navigation strip */}
        <div className="md:hidden border-t border-slate-200 px-4 py-2 flex items-center gap-2 overflow-x-auto">
          {(
            [
              { id: 'live', label: 'Live Bot' },
              { id: 'code', label: 'bot.php Code' },
              { id: 'flows', label: 'Bot Flows' },
              { id: 'deploy', label: 'Deploy Guide' },
            ] as const
          ).map((nav) => (
            <button
              key={nav.id}
              type="button"
              onClick={() => setActiveTab(nav.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === nav.id ? 'bg-slate-900 text-white' : 'text-slate-600 bg-slate-100'
              }`}
            >
              {nav.label}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8">
        {activeTab === 'live' && (
          <div className="space-y-8">
            {/* Live Runner Summary Header */}
            <div className="rounded-xl border border-indigo-200/80 bg-gradient-to-r from-white via-indigo-50/40 to-emerald-50/40 p-6 flex flex-wrap items-center justify-between gap-6">
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-slate-500">
                  <span className={liveStatus?.masterRunning ? 'text-emerald-700 font-semibold' : 'text-amber-700 font-semibold'}>
                    {loadingStatus ? 'Checking...' : liveStatus?.masterRunning ? 'Running' : 'Stopped'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono text-indigo-700">
                    {liveStatus?.masterUsername ? `@${liveStatus.masterUsername}` : 'Master Bot'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    Admins ({liveStatus?.masterAdminIds.length ?? 0}): {liveStatus?.masterAdminIds.join(', ') || 'Not Set'}
                  </span>
                </div>
                <h1 className="text-2xl font-bold tracking-tight text-slate-900">
                  {liveStatus?.masterBotName || 'Telegram Bot Maker Console'}
                </h1>
                {liveStatus?.lastError && (
                  <p className="text-xs text-red-600 font-mono">{liveStatus.lastError}</p>
                )}
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleRestartBot}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg border border-slate-200 bg-white text-slate-800 hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Restart Runner
                </button>
                {liveStatus?.masterUsername && (
                  <a
                    href={`https://t.me/${liveStatus.masterUsername}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 whitespace-nowrap shrink-0"
                  >
                    Open @{liveStatus.masterUsername}
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>
            </div>

            {/* 4-Column KPI Strip */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="rounded-xl border border-slate-200 border-t-4 border-t-blue-500 bg-white p-5">
                <div className="text-xs font-medium text-blue-700">Master Bot Users</div>
                <div className="text-2xl font-bold text-slate-900 mt-1 font-mono tabular-nums">
                  {liveStatus?.stats.masterUsers ?? 0}
                </div>
                <div className="text-xs text-slate-500 mt-1 font-mono tabular-nums">
                  {liveStatus?.stats.activeUsers24h ?? 0} active 24h · {liveStatus?.stats.bannedUsers ?? 0} banned
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 border-t-4 border-t-emerald-500 bg-white p-5">
                <div className="text-xs font-medium text-emerald-700">Verified Devices</div>
                <div className="text-2xl font-bold text-slate-900 mt-1 font-mono tabular-nums">
                  {liveStatus?.stats.verifiedDevices ?? 0}
                </div>
                <div className="text-xs text-slate-500 mt-1 font-mono tabular-nums">
                  Anti-multi-account {liveStatus?.settings.deviceVerify ? 'ON' : 'OFF'}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 border-t-4 border-t-indigo-500 bg-white p-5">
                <div className="text-xs font-medium text-indigo-700">Created Child Bots</div>
                <div className="text-2xl font-bold text-slate-900 mt-1 font-mono tabular-nums">
                  {liveStatus?.stats.totalBots ?? 0}
                </div>
                <div className="text-xs text-slate-500 mt-1 font-mono tabular-nums">
                  {liveStatus?.activeChildRunners ?? 0} live runners
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 border-t-4 border-t-rose-500 bg-white p-5">
                <div className="text-xs font-medium text-rose-700">Child Users &amp; Queues</div>
                <div className="text-2xl font-bold text-slate-900 mt-1 font-mono tabular-nums">
                  {liveStatus?.stats.totalChildUsers ?? 0}
                </div>
                <div className="text-xs text-slate-500 mt-1 font-mono tabular-nums">
                  {liveStatus?.stats.pendingDeposits ?? 0} deposits · {liveStatus?.stats.pendingWithdrawals ?? 0} WD
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
              {/* Left: Live Bot Economy, Template Costs & Deposit Controls */}
              <section className="lg:col-span-5 rounded-xl border border-slate-200 bg-white p-6 space-y-5">
                <div className="border-b border-slate-100 pb-4">
                  <h2 className="text-base font-semibold text-slate-900">Live Master Bot Settings</h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Synced in real time with <span className="font-mono">/admin</span> inside Telegram.
                  </p>
                </div>

                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="liveDaily" className="block text-xs font-medium text-slate-700 mb-1.5">
                        Daily Coins
                      </label>
                      <input
                        id="liveDaily"
                        type="number"
                        min={0}
                        value={dailyCoinsInput}
                        onChange={(e) => setDailyCoinsInput(Number(e.target.value))}
                        className="w-full px-3 py-2 text-sm font-mono tabular-nums rounded-lg border border-slate-200 bg-slate-50 text-slate-900 focus:outline-none focus:bg-white"
                      />
                    </div>
                    <div>
                      <label htmlFor="liveRef" className="block text-xs font-medium text-slate-700 mb-1.5">
                        Master Refer Coins
                      </label>
                      <input
                        id="liveRef"
                        type="number"
                        min={0}
                        value={refCoinsInput}
                        onChange={(e) => setRefCoinsInput(Number(e.target.value))}
                        className="w-full px-3 py-2 text-sm font-mono tabular-nums rounded-lg border border-slate-200 bg-slate-50 text-slate-900 focus:outline-none focus:bg-white"
                      />
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-100">
                    <div className="text-xs font-semibold text-slate-800 mb-2">Bot Template Costs (Coins)</div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label htmlFor="costUpiNormal" className="block text-xs text-slate-600 mb-1">
                          UPI Normal
                        </label>
                        <input
                          id="costUpiNormal"
                          type="number"
                          min={1}
                          value={costUpiNormalInput}
                          onChange={(e) => setCostUpiNormalInput(Number(e.target.value))}
                          className="w-full px-3 py-1.5 text-sm font-mono tabular-nums rounded-lg border border-slate-200 bg-slate-50 text-slate-900 focus:outline-none focus:bg-white"
                        />
                      </div>
                      <div>
                        <label htmlFor="costUpiAdv" className="block text-xs text-slate-600 mb-1">
                          UPI Advanced
                        </label>
                        <input
                          id="costUpiAdv"
                          type="number"
                          min={1}
                          value={costUpiAdvancedInput}
                          onChange={(e) => setCostUpiAdvancedInput(Number(e.target.value))}
                          className="w-full px-3 py-1.5 text-sm font-mono tabular-nums rounded-lg border border-slate-200 bg-slate-50 text-slate-900 focus:outline-none focus:bg-white"
                        />
                      </div>
                      <div>
                        <label htmlFor="costRedeemNormal" className="block text-xs text-slate-600 mb-1">
                          Redeem Normal
                        </label>
                        <input
                          id="costRedeemNormal"
                          type="number"
                          min={1}
                          value={costRedeemNormalInput}
                          onChange={(e) => setCostRedeemNormalInput(Number(e.target.value))}
                          className="w-full px-3 py-1.5 text-sm font-mono tabular-nums rounded-lg border border-slate-200 bg-slate-50 text-slate-900 focus:outline-none focus:bg-white"
                        />
                      </div>
                      <div>
                        <label htmlFor="costRedeemAdv" className="block text-xs text-slate-600 mb-1">
                          Redeem Advanced
                        </label>
                        <input
                          id="costRedeemAdv"
                          type="number"
                          min={1}
                          value={costRedeemAdvancedInput}
                          onChange={(e) => setCostRedeemAdvancedInput(Number(e.target.value))}
                          className="w-full px-3 py-1.5 text-sm font-mono tabular-nums rounded-lg border border-slate-200 bg-slate-50 text-slate-900 focus:outline-none focus:bg-white"
                        />
                      </div>
                      <div>
                        <label htmlFor="costStarNormal" className="block text-xs text-slate-600 mb-1">
                          Star Normal
                        </label>
                        <input
                          id="costStarNormal"
                          type="number"
                          min={1}
                          value={costStarNormalInput}
                          onChange={(e) => setCostStarNormalInput(Number(e.target.value))}
                          className="w-full px-3 py-1.5 text-sm font-mono tabular-nums rounded-lg border border-slate-200 bg-slate-50 text-slate-900 focus:outline-none focus:bg-white"
                        />
                      </div>
                      <div>
                        <label htmlFor="costStarAdv" className="block text-xs text-slate-600 mb-1">
                          Star Advanced
                        </label>
                        <input
                          id="costStarAdv"
                          type="number"
                          min={1}
                          value={costStarAdvancedInput}
                          onChange={(e) => setCostStarAdvancedInput(Number(e.target.value))}
                          className="w-full px-3 py-1.5 text-sm font-mono tabular-nums rounded-lg border border-slate-200 bg-slate-50 text-slate-900 focus:outline-none focus:bg-white"
                        />
                      </div>
                      <div className="col-span-2">
                        <label htmlFor="costGmailBot" className="block text-xs text-slate-600 mb-1">
                          Gmail Buy &amp; Sell Bot
                        </label>
                        <input
                          id="costGmailBot"
                          type="number"
                          min={1}
                          value={costGmailBotInput}
                          onChange={(e) => setCostGmailBotInput(Number(e.target.value))}
                          className="w-full px-3 py-1.5 text-sm font-mono tabular-nums rounded-lg border border-slate-200 bg-slate-50 text-slate-900 focus:outline-none focus:bg-white"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-100 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-800">Deposit &amp; Coin Rate</span>
                      <span className="text-xs font-mono text-slate-500">
                        QR: {liveStatus?.settings.hasDepositQr ? 'Uploaded' : 'Set in /admin'}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2.5">
                      <div>
                        <label htmlFor="depRs" className="block text-xs text-slate-600 mb-1">
                          ₹ Amount
                        </label>
                        <input
                          id="depRs"
                          type="number"
                          min={1}
                          value={depositRsInput}
                          onChange={(e) => setDepositRsInput(Number(e.target.value))}
                          className="w-full px-2.5 py-1.5 text-sm font-mono tabular-nums rounded-lg border border-slate-200 bg-slate-50 text-slate-900"
                        />
                      </div>
                      <div>
                        <label htmlFor="depCoins" className="block text-xs text-slate-600 mb-1">
                          = Coins
                        </label>
                        <input
                          id="depCoins"
                          type="number"
                          min={1}
                          value={depositCoinsInput}
                          onChange={(e) => setDepositCoinsInput(Number(e.target.value))}
                          className="w-full px-2.5 py-1.5 text-sm font-mono tabular-nums rounded-lg border border-slate-200 bg-slate-50 text-slate-900"
                        />
                      </div>
                      <div>
                        <label htmlFor="minDepRs" className="block text-xs text-slate-600 mb-1">
                          Min ₹
                        </label>
                        <input
                          id="minDepRs"
                          type="number"
                          min={1}
                          value={minDepositRsInput}
                          onChange={(e) => setMinDepositRsInput(Number(e.target.value))}
                          className="w-full px-2.5 py-1.5 text-sm font-mono tabular-nums rounded-lg border border-slate-200 bg-slate-50 text-slate-900"
                        />
                      </div>
                    </div>
                    <div>
                      <label htmlFor="depUpi" className="block text-xs text-slate-600 mb-1">
                        Deposit UPI ID
                      </label>
                      <input
                        id="depUpi"
                        type="text"
                        placeholder="merchant@upi"
                        value={depositUpiInput}
                        onChange={(e) => setDepositUpiInput(e.target.value)}
                        className="w-full px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-200 bg-slate-50 text-slate-900"
                      />
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-100 space-y-3">
                    <div>
                      <label htmlFor="verifyUrl" className="block text-xs font-medium text-slate-700 mb-1">
                        Device Verify Base URL
                      </label>
                      <input
                        id="verifyUrl"
                        type="url"
                        placeholder="https://your-app-url"
                        value={verifyBaseUrlInput}
                        onChange={(e) => setVerifyBaseUrlInput(e.target.value)}
                        className="w-full px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-200 bg-slate-50 text-slate-900"
                      />
                    </div>
                    <div>
                      <label htmlFor="liveSupport" className="block text-xs font-medium text-slate-700 mb-1">
                        Support Username
                      </label>
                      <input
                        id="liveSupport"
                        type="text"
                        value={supportInput}
                        onChange={(e) => setSupportInput(e.target.value)}
                        className="w-full px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-200 bg-slate-50 text-slate-900"
                      />
                    </div>
                  </div>

                  <div className="space-y-2 pt-1">
                    <label className="flex items-center justify-between cursor-pointer">
                      <span className="text-xs font-medium text-slate-700">Enable Deposit / Buy Coins</span>
                      <input
                        type="checkbox"
                        checked={depositEnabledInput}
                        onChange={(e) => setDepositEnabledInput(e.target.checked)}
                        className="h-4 w-4 rounded border-slate-300 text-slate-900"
                      />
                    </label>
                    <label className="flex items-center justify-between cursor-pointer">
                      <span className="text-xs font-medium text-slate-700">Master Device Verification</span>
                      <input
                        type="checkbox"
                        checked={deviceVerifyInput}
                        onChange={(e) => setDeviceVerifyInput(e.target.checked)}
                        className="h-4 w-4 rounded border-slate-300 text-slate-900"
                      />
                    </label>
                    <label className="flex items-center justify-between cursor-pointer">
                      <span className="text-xs font-medium text-slate-700">Maintenance Mode</span>
                      <input
                        type="checkbox"
                        checked={maintenanceInput}
                        onChange={(e) => setMaintenanceInput(e.target.checked)}
                        className="h-4 w-4 rounded border-slate-300 text-slate-900"
                      />
                    </label>
                  </div>
                </div>

                <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-3">
                  <span className="text-xs text-emerald-700 font-medium">
                    {savedNotice ? 'Settings saved to SQLite' : ''}
                  </span>
                  <button
                    type="button"
                    disabled={savingSettings}
                    onClick={handleSaveLiveSettings}
                    className="px-4 py-2 text-xs font-medium rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {savingSettings ? 'Saving...' : 'Save Settings'}
                  </button>
                </div>
              </section>

              {/* Right: Created Child Bots Table */}
              <section className="lg:col-span-7 rounded-xl border border-slate-200 bg-white overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">Created Child Bots</h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      7 Templates: UPI, Redeem, Star &amp; Gmail Buy/Sell Bots with Multi-Admin &amp; Device Verify.
                    </p>
                  </div>
                  <span className="text-xs font-mono text-slate-500 tabular-nums">
                    {liveStatus?.bots.length ?? 0} total
                  </span>
                </div>

                {!liveStatus || liveStatus.bots.length === 0 ? (
                  <div className="p-10 text-center space-y-2">
                    <div className="text-sm font-medium text-slate-800">No child bots created yet</div>
                    <p className="text-xs text-slate-500 max-w-md mx-auto">
                      Open <span className="font-mono">@{liveStatus?.masterUsername || 'your_bot'}</span> on Telegram, send <span className="font-mono">/start</span> or <span className="font-mono">/admin</span>, and launch a UPI, Redeem Code, Star, or Gmail Buy &amp; Sell bot.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                        <tr>
                          <th className="py-2.5 px-4 font-medium">Bot</th>
                          <th className="py-2.5 px-4 font-medium">Template</th>
                          <th className="py-2.5 px-4 font-medium">Owner ID</th>
                          <th className="py-2.5 px-4 font-medium text-right">Users</th>
                          <th className="py-2.5 px-4 font-medium text-right">Per Refer</th>
                          <th className="py-2.5 px-4 font-medium text-right">Pending WD</th>
                          <th className="py-2.5 px-4 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {liveStatus.bots.map((b) => (
                          <tr key={b.id} className="hover:bg-slate-50/80">
                            <td className="py-2.5 px-4 font-mono text-slate-900">@{b.botUsername}</td>
                            <td className="py-2.5 px-4 font-medium text-slate-700 whitespace-nowrap">
                              {formatBotType(b.botType)}
                            </td>
                            <td className="py-2.5 px-4 font-mono text-slate-600 tabular-nums">{b.ownerId}</td>
                            <td className="py-2.5 px-4 font-mono text-right text-slate-900 tabular-nums">{b.usersCount}</td>
                            <td className="py-2.5 px-4 font-mono text-right text-slate-700 tabular-nums">
                              {b.currency === '⭐' ? `${b.perRefer} ⭐` : `${b.currency}${b.perRefer}`}
                            </td>
                            <td className="py-2.5 px-4 font-mono text-right text-slate-700 tabular-nums">
                              {b.pendingWithdrawals}
                            </td>
                            <td className="py-2.5 px-4">
                              <span className={b.isActive ? 'text-emerald-700 font-medium' : 'text-slate-500'}>
                                {b.isActive ? 'Active' : 'Paused'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>

            {/* PHP Export Configurator Section */}
            <section className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-4">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">Export Single-File bot.php (For cPanel / PHP Hosting)</h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Generate a customized <span className="font-mono">bot.php</span> if you also want to deploy on external PHP hosting.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleDownloadPhp}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg bg-slate-900 text-white hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download bot.php
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label htmlFor="phpToken" className="block text-xs font-medium text-slate-700 mb-1.5">
                    MASTER_BOT_TOKEN
                  </label>
                  <input
                    id="phpToken"
                    type="text"
                    value={config.masterBotToken}
                    onChange={(e) => setConfig({ ...config, masterBotToken: e.target.value })}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 bg-slate-50"
                  />
                </div>
                <div>
                  <label htmlFor="phpAdmins" className="block text-xs font-medium text-slate-700 mb-1.5">
                    MASTER_ADMIN_IDS
                  </label>
                  <input
                    id="phpAdmins"
                    type="text"
                    value={config.masterAdminIds}
                    onChange={(e) => setConfig({ ...config, masterAdminIds: e.target.value })}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 bg-slate-50"
                  />
                </div>
                <div>
                  <label htmlFor="phpUrl" className="block text-xs font-medium text-slate-700 mb-1.5">
                    WEBHOOK_BASE_URL
                  </label>
                  <input
                    id="phpUrl"
                    type="url"
                    value={config.webhookBaseUrl}
                    onChange={(e) => setConfig({ ...config, webhookBaseUrl: e.target.value })}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 bg-slate-50"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <div className="flex-1 min-w-[240px] rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700 truncate">
                  {setupUrl}
                </div>
                <button
                  type="button"
                  onClick={handleRandomSecret}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  New Key
                </button>
                <button
                  type="button"
                  onClick={handleCopySetupUrl}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {copiedSetupUrl ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedSetupUrl ? 'Copied URL' : 'Copy Setup URL'}
                </button>
              </div>
            </section>
          </div>
        )}

        {activeTab === 'code' && <CodeViewer code={generatedPhp} onDownload={handleDownloadPhp} />}

        {activeTab === 'flows' && <BotFlowPreview config={config} />}

        {activeTab === 'deploy' && (
          <div className="max-w-3xl space-y-6">
            <div>
              <h2 className="text-xl font-bold text-slate-900">Hosting &amp; Deployment Guide</h2>
              <p className="text-sm text-slate-600 mt-1">
                Your bot is auto-running right now on Node.js + SQLite, and <span className="font-mono text-slate-800">bot.php</span> is available for standalone PHP hosting.
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-200">
              <div className="p-6 space-y-2">
                <div className="text-sm font-semibold text-slate-900">01. Live Auto-Runner (Active Now)</div>
                <p className="text-sm text-slate-600">
                  <span className="font-mono text-xs text-slate-800">server.ts</span> runs both your Master Bot (<span className="font-mono text-xs text-slate-800">@{liveStatus?.masterUsername || 'Mezmakerpro1bot'}</span>) and all 7 user-created Child Bot templates (UPI Normal/Advanced, Redeem Normal/Advanced, Star Normal/Advanced, and Gmail Buy &amp; Sell) using long-polling and SQLite (<span className="font-mono text-xs text-slate-800">bot_factory_data.sqlite</span>).
                </p>
              </div>
              <div className="p-6 space-y-2">
                <div className="text-sm font-semibold text-slate-900">02. Configure QR, Admins &amp; Device Verify in Telegram</div>
                <p className="text-sm text-slate-600">
                  Send <span className="font-mono text-xs text-slate-800">/admin</span> to your Master Bot from Telegram Admin ID <span className="font-mono text-xs text-slate-800">8778634400</span> to upload your Deposit QR photo, set coin rates, add extra admins, add unlimited force channels, and toggle Device Verification.
                </p>
              </div>
              <div className="p-6 space-y-2">
                <div className="text-sm font-semibold text-slate-900">03. Optional Standalone PHP Hosting (bot.php)</div>
                <p className="text-sm text-slate-600">
                  To host on cPanel/VPS PHP 8.0+, download <span className="font-mono text-xs text-slate-800">bot.php</span>, upload it to an HTTPS domain, and open the Setup URL once to register webhooks. Do not run the same bot token on two servers simultaneously.
                </p>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
