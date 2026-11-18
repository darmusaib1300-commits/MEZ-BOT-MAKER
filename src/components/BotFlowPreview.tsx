import { useState } from 'react';
import { BotConfig } from '../data/botPhpTemplate';

type RoleView = 'master_user' | 'master_admin' | 'child_user' | 'child_admin';

interface BotFlowPreviewProps {
  config: BotConfig;
}

export function BotFlowPreview({ config }: BotFlowPreviewProps) {
  const [role, setRole] = useState<RoleView>('master_user');
  const [activeScreen, setActiveScreen] = useState<string>('home');

  const handleRoleChange = (nextRole: RoleView) => {
    setRole(nextRole);
    setActiveScreen('home');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Telegram Bot Interaction Flows</h2>
          <p className="text-sm text-slate-500">
            Preview of Master Bot, Deposit QR, 7 Child Bot Templates (UPI, Redeem, Star &amp; Gmail Buy/Sell), Multi-Admin &amp; Device Verification
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
          {(
            [
              { id: 'master_user', label: 'Master Bot' },
              { id: 'master_admin', label: 'Master Admin' },
              { id: 'child_user', label: 'Child Bots' },
              { id: 'child_admin', label: 'Child Admin' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => handleRoleChange(item.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                role === item.id
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Telegram Message Preview */}
        <div className="lg:col-span-7 rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 bg-slate-50">
            <div className="text-sm font-medium text-slate-900">
              {role === 'master_user' && 'Master Bot (@Mezmakerpro1bot)'}
              {role === 'master_admin' && 'Master Admin Panel (/admin)'}
              {role === 'child_user' && 'Child Bot (UPI / Redeem / Star / Gmail)'}
              {role === 'child_admin' && 'Child Bot Admin Panel (/admin)'}
            </div>
            <div className="text-xs text-slate-500 font-mono">
              {role.startsWith('master') ? 'Master Runner' : 'Child Runner'}
            </div>
          </div>

          <div className="p-5 bg-gradient-to-br from-sky-50 via-indigo-50/70 to-emerald-50/60 space-y-4">
            <div className="max-w-lg rounded-xl border border-indigo-200/80 bg-white p-4 text-sm text-slate-800 space-y-2.5 leading-relaxed shadow-sm">
              {role === 'master_user' && activeScreen === 'home' && (
                <>
                  <p className="font-semibold text-slate-900">🌈 Telegram Bot Maker Pro</p>
                  <p className="text-slate-600">
                    Launch colorful UPI, Redeem Code, Telegram Star, and Gmail Buy &amp; Sell Bots with Device Verification.
                  </p>
                  <div className="border-l-4 border-blue-500 bg-blue-50/70 rounded-r-lg p-3 space-y-1 text-xs font-mono text-slate-700">
                    <div>🪙 Your Coins: 10 · 🛡️ Device: Verified</div>
                    <div>🔵 UPI Normal: {config.defaultBotCost} · 🟣 UPI Adv: 10</div>
                    <div>🟢 Redeem Normal: 5 · 🟡 Redeem Adv: 10</div>
                    <div>⭐ Star Normal: 5 · 🌟 Star Adv: 10 · 📧 Gmail Bot: 10</div>
                  </div>
                </>
              )}
              {role === 'master_user' && activeScreen === 'deposit' && (
                <>
                  <p className="font-semibold text-slate-900">💳 Buy Coins (Deposit QR &amp; UPI)</p>
                  <p className="text-slate-600 border-l-4 border-emerald-500 bg-emerald-50/60 rounded-r-lg p-3 text-xs">
                    Displays Admin&apos;s uploaded Deposit QR photo, UPI ID, and current rate (e.g. ₹10 = 5 Coins). Users submit amount + UTR/screenshot for instant approval.
                  </p>
                </>
              )}
              {role === 'master_user' && activeScreen === 'create' && (
                <>
                  <p className="font-semibold text-slate-900">🤖 Choose Bot Template (7 Types)</p>
                  <div className="border-l-4 border-indigo-500 bg-indigo-50/70 rounded-r-lg p-3 space-y-1 text-xs font-mono text-slate-700">
                    <div>1. 💙 UPI Refer &amp; Earn (Normal)</div>
                    <div>2. 💜 UPI Advanced (+Tasks, Gift Codes, Leaderboard)</div>
                    <div>3. 💚 Redeem Code Bot (Normal Stock Delivery)</div>
                    <div>4. 🧡 Redeem Code Advanced (+Stock Viewer, Tasks, Promos)</div>
                    <div>5. ⭐ Normal Star Bot (@username Refer &amp; Star Payouts)</div>
                    <div>6. 🌟 Advanced Star Bot (+Gift Packs 15⭐–100⭐, Tasks, Top)</div>
                    <div>7. 📧 Gmail Buy &amp; Sell Bot (+Deposit QR, Stock, Refer &amp; WD)</div>
                  </div>
                </>
              )}

              {role === 'master_admin' && activeScreen === 'home' && (
                <>
                  <p className="font-semibold text-slate-900">👑 Master Admin Panel</p>
                  <p className="text-slate-700 border-l-4 border-rose-500 bg-rose-50/60 rounded-r-lg p-3 text-xs">
                    Multi-Admin access, Pending Deposits Queue, Deposit QR &amp; Coin Rate setup, 7 Template Prices (incl. Star &amp; Gmail Bot), Unlimited Bulk Force Channels, Device Verification toggle, and Global Broadcast.
                  </p>
                  <p className="text-xs text-slate-500">
                    Zero withdrawal queue here — user payouts stay inside each Child Bot Admin Panel.
                  </p>
                </>
              )}
              {role === 'master_admin' && activeScreen === 'deposit_cfg' && (
                <>
                  <p className="font-semibold text-slate-900">🖼️ Deposit QR &amp; Coin Rate</p>
                  <div className="border-l-4 border-emerald-500 bg-emerald-50/70 rounded-r-lg p-3 space-y-1 text-xs font-mono text-slate-700">
                    <div>Upload QR Photo (stored by Telegram file_id)</div>
                    <div>Set Rate: e.g. ₹10 = 5 Coins</div>
                    <div>Approve (Green) / Reject (Red) queue with auto coin credit</div>
                  </div>
                </>
              )}
              {role === 'master_admin' && activeScreen === 'broadcast' && (
                <>
                  <p className="font-semibold text-slate-900">📢 Broadcast Center</p>
                  <p className="text-slate-600 border-l-4 border-blue-500 bg-blue-50/70 rounded-r-lg p-3 text-xs">
                    Send announcements to Master Bot Users, ALL Child Bots, or any specific Child Bot.
                  </p>
                </>
              )}

              {role === 'child_user' && activeScreen === 'home' && (
                <>
                  <p className="font-semibold text-slate-900">✨ Child Bot (7 Colorful Templates)</p>
                  <div className="border-l-4 border-blue-500 bg-blue-50/70 rounded-r-lg p-3 space-y-1 text-xs font-mono text-slate-700">
                    <div>🛡️ Force Join + Device Verification (/verify)</div>
                    <div>💸 UPI Bots: Daily ₹5 · Per Refer ₹10 · Min WD ₹50</div>
                    <div>🎁 Redeem Bots: Redeem Code Plans &amp; Stock Delivery</div>
                    <div>⭐ Star Bots: @username Star Payouts + Gift Packs (15⭐–100⭐)</div>
                    <div>📧 Gmail Bot: Buy Gmail Stock · Sell Gmail · Deposit QR · WD</div>
                  </div>
                </>
              )}
              {role === 'child_user' && activeScreen === 'withdraw' && (
                <>
                  <p className="font-semibold text-slate-900">💸 Withdraw / Buy &amp; Sell Gmail</p>
                  <p className="text-slate-600 border-l-4 border-emerald-500 bg-emerald-50/70 rounded-r-lg p-3 text-xs">
                    UPI &amp; Gmail bots deduct balance atomically for UPI payouts and notify all Child Admins with Green Approve / Red Reject buttons. Gmail Bots also let users deposit via QR, buy Gmail stock instantly, and sell Gmails for wallet balance.
                  </p>
                </>
              )}

              {role === 'child_admin' && activeScreen === 'home' && (
                <>
                  <p className="font-semibold text-slate-900">👑 Child Bot Admin Panel</p>
                  <p className="text-slate-700 border-l-4 border-rose-500 bg-rose-50/60 rounded-r-lg p-3 text-xs">
                    Owner + Added Child Admins manage Gmail Plans &amp; Stock, Sell Requests, Child Deposit QR &amp; Approvals, Paginated Users List (Ban/Unban + Add/Cut Balance), Withdrawals, Unlimited Force Channels, Broadcast, and Device Verification.
                  </p>
                </>
              )}
              {role === 'child_admin' && activeScreen === 'stock' && (
                <>
                  <p className="font-semibold text-slate-900">📧 Gmail Stock &amp; Child Deposit QR</p>
                  <div className="border-l-4 border-emerald-500 bg-emerald-50/70 rounded-r-lg p-3 space-y-1 text-xs font-mono text-slate-700">
                    <div>Add Gmail Plans &amp; Bulk Stock (email:password per line)</div>
                    <div>Approve/Restock User Sell Requests + Upload Child Deposit QR</div>
                    <div>Manage Users List: Ban/Unban + Add/Cut Wallet Balance</div>
                  </div>
                </>
              )}

              {role === 'master_admin' && (
                <div className="pt-2 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveScreen('deposit_cfg')}
                    className="px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer transition-colors"
                  >
                    🖼️ Deposit QR &amp; Rate
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveScreen('home')}
                    className="px-3 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer transition-colors"
                  >
                    👮 Manage Admins
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveScreen('broadcast')}
                    className="px-3 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer transition-colors"
                  >
                    📢 Broadcast Center
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveScreen('home')}
                    className="px-3 py-2 text-xs font-semibold rounded-lg bg-rose-600 hover:bg-rose-700 text-white cursor-pointer transition-colors"
                  >
                    🔧 Maintenance / Close
                  </button>
                </div>
              )}

              {role === 'child_admin' && (
                <div className="pt-2 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveScreen('stock')}
                    className="px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer transition-colors"
                  >
                    🎁 Redeem Plans &amp; Stock
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveScreen('home')}
                    className="px-3 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer transition-colors"
                  >
                    👮 Manage Admins
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveScreen('home')}
                    className="px-3 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer transition-colors"
                  >
                    📋 Tasks &amp; Gift Codes
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveScreen('home')}
                    className="px-3 py-2 text-xs font-semibold rounded-lg bg-rose-600 hover:bg-rose-700 text-white cursor-pointer transition-colors"
                  >
                    🛡️ Device Verify Toggle
                  </button>
                </div>
              )}
            </div>

            {role === 'master_user' && (
              <div className="max-w-lg grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setActiveScreen('home')}
                  className="px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer transition-colors"
                >
                  🎁 Daily Coins
                </button>
                <button
                  type="button"
                  onClick={() => setActiveScreen('deposit')}
                  className="px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer transition-colors"
                >
                  💳 Buy Coins (QR)
                </button>
                <button
                  type="button"
                  onClick={() => setActiveScreen('create')}
                  className="px-3 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer transition-colors"
                >
                  ➕ Create Bot (7 Types)
                </button>
                <button
                  type="button"
                  onClick={() => setActiveScreen('home')}
                  className="px-3 py-2 text-xs font-semibold rounded-lg bg-rose-600 hover:bg-rose-700 text-white cursor-pointer transition-colors"
                >
                  👑 Master Admin
                </button>
              </div>
            )}

            {role === 'child_user' && (
              <div className="max-w-lg grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setActiveScreen('home')}
                  className="px-3 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer transition-colors"
                >
                  💰 Balance / Refer
                </button>
                <button
                  type="button"
                  onClick={() => setActiveScreen('withdraw')}
                  className="px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer transition-colors"
                >
                  💸 Withdraw / Redeem
                </button>
                <button
                  type="button"
                  onClick={() => setActiveScreen('home')}
                  className="px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer transition-colors"
                >
                  🎁 Daily Bonus &amp; Gift
                </button>
                <button
                  type="button"
                  onClick={() => setActiveScreen('home')}
                  className="px-3 py-2 text-xs font-semibold rounded-lg bg-rose-600 hover:bg-rose-700 text-white cursor-pointer transition-colors"
                >
                  👑 Admin Panel
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right: Feature Responsibility Table */}
        <div className="lg:col-span-5 rounded-xl border border-slate-200 bg-white divide-y divide-slate-200">
          <div className="px-5 py-3.5 bg-gradient-to-r from-blue-50 via-indigo-50 to-emerald-50">
            <h3 className="text-sm font-semibold text-slate-900">🌈 Colorful Telegram UI + Bot Factory</h3>
          </div>
          <div className="p-5 space-y-4 text-sm">
            <div>
              <div className="font-medium text-slate-900">Native Blue, Green &amp; Red Buttons</div>
              <p className="text-slate-600 mt-1">
                Both Master Bot and every Child Bot render native Telegram colored buttons (<span className="font-mono text-xs text-blue-700">primary</span>, <span className="font-mono text-xs text-emerald-700">success</span>, <span className="font-mono text-xs text-rose-700">danger</span>) plus HTML <span className="font-mono text-xs">&lt;blockquote&gt;</span> highlight cards.
              </p>
            </div>
            <div className="border-t border-slate-100 pt-4">
              <div className="font-medium text-slate-900">7 Child Bot Templates (INR, Stars &amp; Gmail)</div>
              <p className="text-slate-600 mt-1">
                Users create UPI Normal/Advanced, Redeem Code Normal/Advanced, Star Normal/Advanced (⭐ Telegram Stars), and Gmail Buy &amp; Sell Bots (with Stock, Sell Queue, Deposit QR, Users List, Ban/Balance &amp; Withdrawals).
              </p>
            </div>
            <div className="border-t border-slate-100 pt-4">
              <div className="font-medium text-slate-900">Deposit QR &amp; Anti-Cheat Device Verification</div>
              <p className="text-slate-600 mt-1">
                Master &amp; Gmail Bot admins set Deposit QR photos, review deposits inline, manage Multi-Admin teams, and enforce one-device-per-account verification via <span className="font-mono text-xs text-slate-800">/verify</span>.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
