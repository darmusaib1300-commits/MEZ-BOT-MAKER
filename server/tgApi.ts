import { esc, type ChannelRow } from './db.ts';

export interface TgApiResult<T = Record<string, unknown>> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function tgApi<T = Record<string, unknown>>(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
  timeoutMs = 15000
): Promise<TgApiResult<T>> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

  const onParentAbort = () => timeoutController.abort();
  if (signal) {
    if (signal.aborted) timeoutController.abort();
    else signal.addEventListener('abort', onParentAbort, { once: true });
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: timeoutController.signal,
    });
    return (await res.json()) as TgApiResult<T>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, description: msg };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onParentAbort);
  }
}

export async function sendMsg(
  token: string,
  chatId: number | string,
  text: string,
  replyMarkup?: Record<string, unknown>
): Promise<TgApiResult> {
  const params: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (replyMarkup) params.reply_markup = replyMarkup;
  return tgApi(token, 'sendMessage', params);
}

export async function sendPhotoMsg(
  token: string,
  chatId: number | string,
  photoFileId: string,
  caption: string,
  replyMarkup?: Record<string, unknown>
): Promise<TgApiResult> {
  const params: Record<string, unknown> = {
    chat_id: chatId,
    photo: photoFileId,
    caption,
    parse_mode: 'HTML',
  };
  if (replyMarkup) params.reply_markup = replyMarkup;
  return tgApi(token, 'sendPhoto', params);
}

export async function editMsg(
  token: string,
  chatId: number | string,
  messageId: number,
  text: string,
  replyMarkup?: Record<string, unknown>
): Promise<TgApiResult> {
  const params: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (replyMarkup) params.reply_markup = replyMarkup;
  return tgApi(token, 'editMessageText', params);
}

export async function answerCb(token: string, cbId: string, text = '', showAlert = false): Promise<void> {
  const params: Record<string, unknown> = { callback_query_id: cbId };
  if (text) {
    params.text = text;
    params.show_alert = showAlert;
  }
  await tgApi(token, 'answerCallbackQuery', params);
}

export async function checkForceJoin(token: string, channels: ChannelRow[], userId: number): Promise<ChannelRow[]> {
  const unjoined: ChannelRow[] = [];
  for (const ch of channels) {
    const res = await tgApi<{ status: string; is_member?: boolean }>(token, 'getChatMember', {
      chat_id: ch.chat_id,
      user_id: userId,
    });
    if (!res.ok || !res.result) continue;
    const st = res.result.status || 'left';
    const isMem =
      st === 'creator' ||
      st === 'administrator' ||
      st === 'member' ||
      (st === 'restricted' && Boolean(res.result.is_member));
    if (!isMem) unjoined.push(ch);
  }
  return unjoined;
}

export type TgButtonStyle = 'primary' | 'success' | 'danger';

export function buildForceJoinMarkup(channels: ChannelRow[], verifyCallback: string): Record<string, unknown> {
  const rows: Array<Array<Record<string, string>>> = [];
  channels.forEach((ch, idx) => {
    const label = ch.title || `Channel ${idx + 1}`;
    if (ch.invite_link) rows.push([{ text: `📢 Join ${label}`, url: ch.invite_link, style: 'primary' }]);
  });
  rows.push([{ text: '✅ I Joined / Verify', callback_data: verifyCallback, style: 'success' }]);
  return { inline_keyboard: rows };
}

export async function resolveChannelInput(
  token: string,
  rawInput: string
): Promise<{ ok: true; chatId: string; title: string; inviteLink: string } | { ok: false; error: string }> {
  let input = rawInput.trim();
  let manualLink = '';
  if (input.includes('|')) {
    const [c, l] = input.split('|', 2).map((s) => s.trim());
    input = c;
    manualLink = l;
  }
  const linkMatch = input.match(/^https?:\/\/t\.me\/([A-Za-z0-9_]+)$/i);
  if (linkMatch) input = '@' + linkMatch[1];

  const chatRes = await tgApi<{ id: number; title?: string; username?: string; invite_link?: string }>(
    token,
    'getChat',
    { chat_id: input }
  );
  if (!chatRes.ok || !chatRes.result) {
    return {
      ok: false,
      error: chatRes.description || 'Channel not found. Make sure the bot is an Admin in that channel.',
    };
  }

  const chat = chatRes.result;
  const chatId = String(chat.id);
  const title = String(chat.title || chat.username || chatId);
  const username = chat.username || '';

  const meRes = await tgApi<{ id: number }>(token, 'getMe');
  if (meRes.ok && meRes.result) {
    const memRes = await tgApi<{ status: string }>(token, 'getChatMember', {
      chat_id: chatId,
      user_id: meRes.result.id,
    });
    const botStatus = memRes.result?.status || 'left';
    if (botStatus !== 'administrator' && botStatus !== 'creator') {
      return {
        ok: false,
        error: `Please make this bot an Administrator in "${esc(title)}" first so it can verify members.`,
      };
    }
  }

  let inviteLink = manualLink;
  if (!inviteLink && username) inviteLink = `https://t.me/${username}`;
  if (!inviteLink && chat.invite_link) inviteLink = chat.invite_link;
  if (!inviteLink) {
    const exp = await tgApi<string>(token, 'exportChatInviteLink', { chat_id: chatId });
    if (exp.ok && typeof exp.result === 'string') inviteLink = exp.result;
  }

  if (!inviteLink) {
    return {
      ok: false,
      error: 'Private channel detected without invite link. Send format: <code>-1001234567890 | https://t.me/+InviteLink</code>',
    };
  }

  return { ok: true, chatId, title, inviteLink };
}

export async function executeBroadcast(
  token: string,
  userIds: number[],
  text: string,
  inlineMarkup?: Record<string, unknown>
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const uid of userIds) {
    const res = await sendMsg(token, uid, text, inlineMarkup);
    if (res.ok) {
      sent++;
    } else if (res.error_code === 429) {
      const retry = Math.min(res.parameters?.retry_after ?? 2, 10);
      await sleep(retry * 1000);
      const retryRes = await sendMsg(token, uid, text, inlineMarkup);
      if (retryRes.ok) sent++;
      else failed++;
    } else {
      failed++;
    }
    await sleep(35);
  }
  return { sent, failed };
}
