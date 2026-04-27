/**
 * CPAMC Notifications v3
 *
 * Setara `src/notifications/service.py` di claude-code-telegram.
 * Mengirim pesan proaktif ke Telegram (dari webhook, scheduler, atau API)
 * dengan rate limiting per chat (1 pesan / ~1.1 detik) supaya tidak kena
 * 429 dari Telegram.
 *
 * Bot Telegram diinject lewat `init({ bot })`. Kalau bot tidak ada,
 * pesan tetap di-queue tapi cuma di-log ke stdout (tidak dikirim).
 */

const audit = require('./audit');

const SEND_INTERVAL_MS = 1100; // ~1 pesan/detik per chat (limit Telegram)

class NotificationService {
  constructor() {
    this.bot = null; // Telegraf bot
    this.queue = [];
    this.lastSendPerChat = new Map(); // chatId → timestamp ms
    this.processing = false;
    this.defaultChatIds = (process.env.NOTIFICATION_CHAT_IDS || '')
      .split(',').map(s => s.trim()).filter(Boolean);
  }

  init({ bot }) {
    this.bot = bot;
  }

  /** Enqueue a message. Returns immediately. */
  async send(chatId, text, options = {}) {
    if (!chatId) {
      // Broadcast ke default chat IDs
      for (const id of this.defaultChatIds) {
        await this.send(id, text, options);
      }
      return;
    }
    this.queue.push({ chatId: String(chatId), text, options });
    if (!this.processing) this._drain();
  }

  /** Broadcast to all default chat IDs. */
  async broadcast(text, options = {}) {
    for (const id of this.defaultChatIds) {
      await this.send(id, text, options);
    }
  }

  async _drain() {
    this.processing = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      const last = this.lastSendPerChat.get(item.chatId) || 0;
      const wait = Math.max(0, last + SEND_INTERVAL_MS - Date.now());
      if (wait > 0) await new Promise(r => setTimeout(r, wait));

      try {
        if (!this.bot) {
          console.log(`[notify→${item.chatId}] (bot offline) ${item.text.slice(0, 80)}`);
        } else {
          // Split jika terlalu panjang
          const chunks = this._splitMsg(item.text);
          for (const chunk of chunks) {
            await this.bot.telegram.sendMessage(item.chatId, chunk, {
              parse_mode: 'Markdown',
              ...item.options
            }).catch(async (e) => {
              // Fallback tanpa Markdown jika parse error
              if (String(e?.description || '').includes('parse')) {
                await this.bot.telegram.sendMessage(item.chatId, chunk, item.options).catch(() => {});
              } else {
                throw e;
              }
            });
          }
        }
        this.lastSendPerChat.set(item.chatId, Date.now());
        await audit.logNotification(item.chatId, { preview: item.text.slice(0, 120) });
      } catch (e) {
        console.error(`Notification send failed → ${item.chatId}:`, e.message);
        await audit.logError(item.chatId, e, 'notification.send', { platform: 'telegram' });
      }
    }
    this.processing = false;
  }

  _splitMsg(text, max = 4000) {
    if (text.length <= max) return [text];
    const chunks = [];
    for (let i = 0; i < text.length; i += max) chunks.push(text.slice(i, i + max));
    return chunks;
  }
}

module.exports = new NotificationService();
