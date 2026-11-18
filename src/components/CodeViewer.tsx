import { useMemo, useState } from 'react';
import { Check, Copy, Download, Search } from 'lucide-react';

interface CodeViewerProps {
  code: string;
  onDownload: () => void;
}

const SECTIONS = [
  { label: 'Config', match: '// 1. CONFIGURATION' },
  { label: 'SQLite DB', match: '// 2. DATABASE INITIALIZATION' },
  { label: 'Telegram API', match: '// 3. TELEGRAM BOT API HELPERS' },
  { label: 'Setup & Router', match: '// 4. SETUP ENDPOINT' },
  { label: 'Master Bot', match: '// 6. MASTER BOT ENGINE' },
  { label: 'Child UPI Bot', match: '// 7. CHILD BOT ENGINE' },
];

export function CodeViewer({ code, onDownload }: CodeViewerProps) {
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState('');
  const [activeSection, setActiveSection] = useState('Config');

  const lines = useMemo(() => code.split('\n'), [code]);

  const filteredLines = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) {
      return lines.map((line, index) => ({ line, num: index + 1 }));
    }
    return lines
      .map((line, index) => ({ line, num: index + 1 }))
      .filter((item) => item.line.toLowerCase().includes(q));
  }, [lines, search]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const jumpToSection = (section: { label: string; match: string }) => {
    setActiveSection(section.label);
    setSearch('');
    const lineIndex = lines.findIndex((l) => l.includes(section.match));
    if (lineIndex >= 0) {
      const el = document.getElementById(`php-line-${lineIndex + 1}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Complete Single-File Source: bot.php</h2>
          <p className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
            {lines.length} lines · {(new Blob([code]).size / 1024).toFixed(1)} KB · PHP 8.0+ / SQLite PDO / cURL
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg border border-slate-200 bg-white text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied bot.php' : 'Copy Code'}
          </button>
          <button
            type="button"
            onClick={onDownload}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg bg-slate-900 text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Download bot.php
          </button>
        </div>
      </div>

      {/* Section Jump Bar & Search */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-1">
          {SECTIONS.map((sec) => (
            <button
              key={sec.label}
              type="button"
              onClick={() => jumpToSection(sec)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeSection === sec.label && !search
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              {sec.label}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter lines in bot.php..."
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 bg-slate-50 text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:bg-white"
          />
        </div>
      </div>

      {/* Code Window */}
      <div className="rounded-xl border border-slate-800 bg-slate-950 text-slate-100 overflow-hidden">
        <div className="max-h-[620px] overflow-auto p-4 font-mono text-xs leading-5">
          {filteredLines.length === 0 ? (
            <div className="py-10 text-center text-slate-400">
              No lines matching &ldquo;{search}&rdquo;.
            </div>
          ) : (
            <table className="w-full border-collapse">
              <tbody>
                {filteredLines.map((item) => (
                  <tr key={item.num} id={`php-line-${item.num}`} className="hover:bg-slate-900/70">
                    <td className="select-none pr-4 text-right text-slate-500 w-12 align-top tabular-nums">
                      {item.num}
                    </td>
                    <td className="whitespace-pre text-slate-100">{item.line || ' '}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
