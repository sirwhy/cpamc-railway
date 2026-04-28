/**
 * CPAMC Telegram Bot v3
 * Enhanced with features from claude-code-telegram:
 * - Voice message transcription (Whisper-compatible)
 * - Image/photo analysis
 * - File upload handling + code analysis
 * - Draft streaming (live typing updates)
 * - Quick action inline keyboards
 * - Session export commands
 * - Rate limiting per user
 * - Conversation context with follow-up suggestions
 * - Git operations
 */

const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
require('dotenv').config();

const db = require('../core/db');
const engine = require('../core/engine');
const sessionExport = require('../core/session_export');
const audit = require('../core/audit');
const notifications = require('../core/notifications');

// Init MongoDB
db.connect();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN belum diisi di environment variables');
  process.exit(1);
}

// Allowed user IDs (optional security)
const ALLOWED_USERS = process.env.ALLOWED_USERS
  ? process.env.ALLOWED_USERS.split(',').map(s => s.trim())
  : [];

const bot = new Telegraf(TOKEN);

// ── Helpers ──────────────────────────────────────────────────────

function splitMsg(text, max = 4000) {
  if (text.length <= max) return [text];
  const chunks = [];
  for (let i = 0; i < text.length; i += max) {
    chunks.push(text.slice(i, i + max));
  }
  return chunks;
}

function isAllowed(userId) {
  if (!ALLOWED_USERS.length) return true;
  return ALLOWED_USERS.includes(userId.toString());
}

/**
 * Draft streaming - sends live "typing" updates as AI processes
 * Inspired by claude-code-telegram DraftStreamer
 */
class DraftStreamer {
  constructor(ctx) {
    this.ctx = ctx;
    this.statusMsg = null;
    this.disabled = false;
  }

  async update(text) {
    if (this.disabled) return;
    try {
      if (!this.statusMsg) {
        this.statusMsg = await this.ctx.reply(text, { parse_mode: 'Markdown' });
      } else {
        await this.ctx.telegram.editMessageText(
          this.ctx.chat.id,
          this.statusMsg.message_id,
          null,
          text,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (e) {
      this.disabled = true;
    }
  }

  async clear() {
    if (this.statusMsg) {
      try {
        await this.ctx.telegram.deleteMessage(this.ctx.chat.id, this.statusMsg.message_id);
      } catch (e) {}
      this.statusMsg = null;
    }
  }
}

/**
 * Quick action buttons - inspired by claude-code-telegram quick_actions
 */
function getQuickActionsKeyboard(response) {
  const buttons = [];
  const lower = response.toLowerCase();

  // Context-aware suggestions based on AI response content
  if (lower.includes('error') || lower.includes('bug') || lower.includes('gagal')) {
    buttons.push([Markup.button.callback('🔍 Analisis Error', 'qa_analyze_error')]);
  }
  if (lower.includes('code') || lower.includes('kode') || lower.includes('```')) {
    buttons.push([
      Markup.button.callback('📋 Copy Code', 'qa_note_code'),
      Markup.button.callback('🧪 Jalankan', 'qa_run_code')
    ]);
  }
  if (lower.includes('file') || lower.includes('direktori') || lower.includes('folder')) {
    buttons.push([Markup.button.callback('📂 List Files', 'qa_list_files')]);
  }
  if (lower.includes('git') || lower.includes('commit') || lower.includes('branch')) {
    buttons.push([
      Markup.button.callback('📊 Git Status', 'qa_git_status'),
      Markup.button.callback('📝 Git Log', 'qa_git_log')
    ]);
  }

  // Always offer export and clear
  if (buttons.length > 0) {
    buttons.push([
      Markup.button.callback('📤 Export MD', 'qa_export_md'),
      Markup.button.callback('🗑 Clear', 'qa_clear')
    ]);
  }

  if (buttons.length === 0) return null;
  return Markup.inlineKeyboard(buttons);
}

/**
 * Format response for Telegram (HTML-safe)
 * Inspired by claude-code-telegram formatting module
 */
function formatResponse(text) {
  // Basic markdown to Telegram-friendly markdown
  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')  // bold
    .trim();
}

/**
 * Download Telegram file to buffer
 */
async function downloadFile(ctx, fileId) {
  const file = await ctx.telegram.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  return await res.buffer();
}

// ── Auth Middleware ──────────────────────────────────────────────

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (userId && !isAllowed(userId)) {
    await audit.logAuth(userId, false, 'not in ALLOWED_USERS', { platform: 'telegram' });
    return ctx.reply('⛔ Akses ditolak. User tidak diizinkan.');
  }
  return next();
});

// ── Commands ────────────────────────────────────────────────────

bot.start(ctx => ctx.reply(
  `🤖 *CPAMC AI Framework v3*\n\n` +
  `Halo, ${ctx.from.first_name}! Aku asisten AI berbasis Claude yang powerful.\n\n` +
  `*Fitur unggulan:*\n` +
  `• 🔧 Agentic mode — eksekusi command, baca/tulis file, git\n` +
  `• 🖼️ Analisis gambar & screenshot\n` +
  `• 📎 Upload & analisis file/kode\n` +
  `• 🎤 Transkripsi voice message\n` +
  `• 🧠 Memory persisten antar sesi\n` +
  `• 🔌 Skills system yang bisa di-customize\n` +
  `• 📤 Export session ke Markdown/JSON/HTML\n\n` +
  `*Commands:*\n` +
  `/help — bantuan lengkap\n` +
  `/skills — kelola skills\n` +
  `/memory — lihat memori\n` +
  `/status — status engine\n` +
  `/export — export session\n` +
  `/clear — hapus history\n\n` +
  `Mulai chat sekarang! 💬`,
  { parse_mode: 'Markdown' }
));

bot.command('help', async ctx => {
  const res = await engine.chat(ctx.from.id.toString(), '/help', { platform: 'telegram' });
  await ctx.reply(res.text, { parse_mode: 'Markdown' });
});

bot.command('skills', async ctx => {
  const res = await engine.chat(ctx.from.id.toString(), '/skills', { platform: 'telegram' });
  await ctx.reply(res.text, { parse_mode: 'Markdown' });
});

bot.command('memory', async ctx => {
  const res = await engine.chat(ctx.from.id.toString(), '/memory', { platform: 'telegram' });
  await ctx.reply(res.text, { parse_mode: 'Markdown' });
});

bot.command('status', async ctx => {
  const res = await engine.chat(ctx.from.id.toString(), '/status', { platform: 'telegram' });
  await ctx.reply(res.text, { parse_mode: 'Markdown' });
});

bot.command('clear', async ctx => {
  const res = await engine.chat(ctx.from.id.toString(), '/clear', { platform: 'telegram' });
  await ctx.reply(res.text);
});

bot.command('new', async ctx => {
  const res = await engine.chat(ctx.from.id.toString(), '/new', { platform: 'telegram' });
  await ctx.reply(res.text);
});

bot.command('stop', async ctx => {
  engine.requestCancel(ctx.from.id.toString());
  await audit.logCommand(ctx.from.id, '/stop', [], { platform: 'telegram' });
  await ctx.reply('🛑 Stop signal dikirim. Tool loop akan berhenti pada iterasi berikutnya.');
});

bot.command('verbose', async ctx => {
  const res = await engine.chat(ctx.from.id.toString(), ctx.message.text, { platform: 'telegram' });
  await ctx.reply(res.text, { parse_mode: 'Markdown' });
});

bot.command('pwd', async ctx => {
  const res = await engine.chat(ctx.from.id.toString(), '/pwd', { platform: 'telegram' });
  await ctx.reply(res.text, { parse_mode: 'Markdown' });
});

bot.command('cd', async ctx => {
  const res = await engine.chat(ctx.from.id.toString(), ctx.message.text, { platform: 'telegram' });
  await ctx.reply(res.text, { parse_mode: 'Markdown' });
});

bot.command('ls', async ctx => {
  const res = await engine.chat(ctx.from.id.toString(), '/ls', { platform: 'telegram' });
  await ctx.reply(res.text, { parse_mode: 'Markdown' });
});

bot.command('projects', async ctx => {
  const res = await engine.chat(ctx.from.id.toString(), '/projects', { platform: 'telegram' });
  await ctx.reply(res.text, { parse_mode: 'Markdown' });
});

bot.command('git', async ctx => {
  const res = await engine.chat(ctx.from.id.toString(), ctx.message.text, { platform: 'telegram' });
  await ctx.reply(res.text, { parse_mode: 'Markdown' });
});

bot.command('jobs', async ctx => {
  const res = await engine.chat(ctx.from.id.toString(), '/jobs', { platform: 'telegram' });
  await ctx.reply(res.text, { parse_mode: 'Markdown' });
});

bot.command('audit', async ctx => {
  const res = await engine.chat(ctx.from.id.toString(), '/audit', { platform: 'telegram' });
  await ctx.reply(res.text, { parse_mode: 'Markdown' });
});

bot.command('forget', async ctx => {
  const arg = ctx.message.text.split(' ').slice(1).join(' ');
  const cmd = arg ? `/forget ${arg}` : '/forget';
  const res = await engine.chat(ctx.from.id.toString(), cmd, { platform: 'telegram' });
  await ctx.reply(res.text, { parse_mode: 'Markdown' });
});

bot.command('remember', async ctx => {
  const text = ctx.message.text.split(' ').slice(1).join(' ');
  if (!text) return ctx.reply('Gunakan: /remember <teks yang ingin diingat>');
  const res = await engine.chat(ctx.from.id.toString(), `/remember ${text}`, { platform: 'telegram' });
  await ctx.reply(res.text);
});

// Session Export command - inspired by claude-code-telegram session_export
bot.command('export', async ctx => {
  const parts = ctx.message.text.split(' ');
  const format = parts[1] || 'markdown';
  const validFormats = ['markdown', 'md', 'json', 'html'];

  if (!validFormats.includes(format)) {
    return ctx.reply(`Format tidak valid. Gunakan: /export markdown | /export json | /export html`);
  }

  const session = engine.getSession(ctx.from.id.toString());
  if (!session.history.length) {
    return ctx.reply('Belum ada history chat untuk di-export.');
  }

  const actualFormat = format === 'md' ? 'markdown' : format;
  const exported = sessionExport.export(session.history, actualFormat, ctx.from.id.toString());

  // Send as document
  await ctx.replyWithDocument(
    {
      source: Buffer.from(exported.content, 'utf8'),
      filename: exported.filename
    },
    { caption: `📤 Session di-export — ${session.history.length} pesan` }
  );
});

// ── Quick Actions Callbacks ────────────────────────────────────

bot.action('qa_analyze_error', async ctx => {
  await ctx.answerCbQuery('Menganalisis error...');
  await handleChat(ctx, 'Tolong analisis error di atas secara detail dan berikan solusinya.');
});

bot.action('qa_run_code', async ctx => {
  await ctx.answerCbQuery('Menyiapkan eksekusi...');
  await handleChat(ctx, 'Tolong jalankan kode di atas di workspace dan tunjukkan hasilnya.');
});

bot.action('qa_list_files', async ctx => {
  await ctx.answerCbQuery();
  await handleChat(ctx, 'Tampilkan daftar file di workspace.');
});

bot.action('qa_git_status', async ctx => {
  await ctx.answerCbQuery();
  await handleChat(ctx, 'Tampilkan status git di workspace.');
});

bot.action('qa_git_log', async ctx => {
  await ctx.answerCbQuery();
  await handleChat(ctx, 'Tampilkan 10 commit terbaru di workspace.');
});

bot.action('qa_export_md', async ctx => {
  await ctx.answerCbQuery('Exporting...');
  const session = await engine.loadSession(ctx.from.id.toString());
  if (!session.history.length) return ctx.reply('Belum ada history.');
  const exported = sessionExport.export(session.history, 'markdown', ctx.from.id.toString());
  await ctx.replyWithDocument({
    source: Buffer.from(exported.content, 'utf8'),
    filename: exported.filename
  }, { caption: '📤 Session exported' });
});

bot.action('qa_clear', async ctx => {
  await ctx.answerCbQuery('Cleared!');
  engine.clearSession(ctx.from.id.toString());
  await ctx.reply('✓ History chat dihapus.');
});

// Stop button — cancels running tool loop (dipasang otomatis kalau loop
// sedang jalan). User juga bisa /stop di chat.
bot.action('qa_stop', async ctx => {
  await ctx.answerCbQuery('Stopping...');
  engine.requestCancel(ctx.from.id.toString());
  await ctx.reply('🛑 Stop signal dikirim.');
});

bot.action('qa_note_code', async ctx => {
  await ctx.answerCbQuery('💡 Kode sudah bisa dicopy dari pesan di atas!');
});

// ── Core Chat Handler ──────────────────────────────────────────

async function handleChat(ctx, userText, extras = {}) {
  const userId = ctx.from.id.toString();
  const streamer = new DraftStreamer(ctx);

  try {
    await ctx.sendChatAction('typing');

    const res = await engine.chat(userId, userText, {
      platform: 'telegram',
      onStatus: async (msg) => {
        await ctx.sendChatAction('typing');
        await streamer.update(`⚙️ ${msg}`);
      },
      ...extras
    });

    await streamer.clear();

    if (!res.text) return;

    const formatted = formatResponse(res.text);
    const chunks = splitMsg(formatted);

    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const keyboard = isLast ? getQuickActionsKeyboard(res.text) : null;

      try {
        await ctx.reply(chunks[i], {
          parse_mode: 'Markdown',
          ...(keyboard && { reply_markup: keyboard.reply_markup })
        });
      } catch (e) {
        // Fallback: send without parse_mode if markdown fails
        await ctx.reply(chunks[i], {
          ...(keyboard && { reply_markup: keyboard.reply_markup })
        });
      }
    }
  } catch (e) {
    await streamer.clear();
    console.error('Chat error:', e.message);
    await ctx.reply(`❌ Error: ${e.message}`);
  }
}

// ── Text Messages ──────────────────────────────────────────────

bot.on('text', async ctx => {
  const text = ctx.message.text;

  // Handle inline commands (skill, remember, forget, search)
  if (
    text.startsWith('/skill ') ||
    text.startsWith('/remember ') ||
    text.startsWith('/forget ') ||
    text.startsWith('/search ')
  ) {
    try {
      const res = await engine.chat(ctx.from.id.toString(), text, { platform: 'telegram' });
      return ctx.reply(res.text, { parse_mode: 'Markdown' });
    } catch (e) {
      return ctx.reply('❌ ' + e.message);
    }
  }

  if (text.startsWith('/')) return;

  await handleChat(ctx, text);
});

// ── Image/Photo Handler ─────────────────────────────────────────
// Inspired by claude-code-telegram image_handler

bot.on('photo', async ctx => {
  const userId = ctx.from.id.toString();
  const caption = ctx.message.caption || 'Analisis gambar ini secara detail.';

  try {
    await ctx.sendChatAction('upload_photo');
    const streamer = new DraftStreamer(ctx);

    // Get highest resolution photo
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];

    await streamer.update('🖼️ Mengunduh dan menganalisis gambar...');

    const imageBuffer = await downloadFile(ctx, photo.file_id);
    const imageBase64 = imageBuffer.toString('base64');

    await streamer.clear();

    // Chat with image context
    const res = await engine.chat(userId, caption, {
      platform: 'telegram',
      imageBase64,
      imageType: 'image/jpeg',
      onStatus: async (msg) => {
        await ctx.sendChatAction('typing');
        await streamer.update(`⚙️ ${msg}`);
      }
    });

    await streamer.clear();

    const chunks = splitMsg(formatResponse(res.text));
    for (const chunk of chunks) {
      await ctx.reply(chunk, { parse_mode: 'Markdown' }).catch(() => ctx.reply(chunk));
    }
  } catch (e) {
    console.error('Photo error:', e.message);
    await ctx.reply(`❌ Error analisis gambar: ${e.message}`);
  }
});

// ── Document/File Handler ────────────────────────────────────────
// Inspired by claude-code-telegram file_handler

bot.on('document', async ctx => {
  const userId = ctx.from.id.toString();
  const doc = ctx.message.document;
  const caption = ctx.message.caption || '';

  // Max file size: 10MB
  const MAX_SIZE = 10 * 1024 * 1024;
  if (doc.file_size > MAX_SIZE) {
    return ctx.reply('❌ File terlalu besar (max 10MB).');
  }

  try {
    await ctx.sendChatAction('upload_document');
    const streamer = new DraftStreamer(ctx);
    await streamer.update('📎 Mengunduh dan menganalisis file...');

    const fileBuffer = await downloadFile(ctx, doc.file_id);
    const fileName = doc.file_name || 'file';
    const ext = path.extname(fileName).toLowerCase();

    // Text-based files: read content
    const textExts = [
      '.txt', '.md', '.js', '.ts', '.py', '.java', '.c', '.cpp',
      '.go', '.rs', '.rb', '.php', '.html', '.css', '.json', '.yaml',
      '.yml', '.xml', '.sh', '.bash', '.zsh', '.fish', '.env',
      '.toml', '.ini', '.cfg', '.conf', '.csv', '.sql', '.graphql',
      '.dockerfile', '.gitignore', '.htaccess', '.nginx'
    ];

    let fileContent = '';
    let fileInfo = `📎 *File:* ${fileName}\n📏 *Ukuran:* ${(doc.file_size / 1024).toFixed(1)}KB\n\n`;

    if (textExts.includes(ext) || doc.mime_type?.startsWith('text/')) {
      fileContent = fileBuffer.toString('utf8');
      if (fileContent.length > 15000) {
        fileContent = fileContent.slice(0, 15000) + '\n...[terpotong]';
      }

      // Detect language
      const langMap = {
        '.js': 'JavaScript', '.ts': 'TypeScript', '.py': 'Python',
        '.java': 'Java', '.go': 'Go', '.rs': 'Rust', '.rb': 'Ruby',
        '.php': 'PHP', '.c': 'C', '.cpp': 'C++', '.cs': 'C#'
      };
      const lang = langMap[ext] || ext.slice(1).toUpperCase() || 'Text';

      const userPrompt = caption
        ? `${fileInfo}File ${lang} "${fileName}":\n\`\`\`${ext.slice(1)}\n${fileContent}\n\`\`\`\n\nPertanyaan: ${caption}`
        : `${fileInfo}Analisis file ${lang} ini:\n\`\`\`${ext.slice(1)}\n${fileContent}\n\`\`\`\n\nBerikan analisis lengkap: tujuan file, struktur, kualitas kode, dan saran perbaikan jika ada.`;

      await streamer.clear();
      await handleChat(ctx, userPrompt);

    } else if (doc.mime_type?.startsWith('image/')) {
      // Image document
      const imageBase64 = fileBuffer.toString('base64');
      await streamer.clear();

      const res = await engine.chat(userId, caption || 'Analisis gambar ini.', {
        platform: 'telegram',
        imageBase64,
        imageType: doc.mime_type
      });

      const chunks = splitMsg(formatResponse(res.text));
      for (const chunk of chunks) {
        await ctx.reply(chunk, { parse_mode: 'Markdown' }).catch(() => ctx.reply(chunk));
      }
    } else {
      await streamer.clear();
      await ctx.reply(
        `${fileInfo}📦 File binary (${doc.mime_type || 'unknown'}) tidak bisa dibaca langsung.\n` +
        `Jika ini adalah kode/teks, pastikan ekstensi file benar.`
      );
    }
  } catch (e) {
    console.error('Document error:', e.message);
    await ctx.reply(`❌ Error memproses file: ${e.message}`);
  }
});

// ── Voice Handler ──────────────────────────────────────────────
// Inspired by claude-code-telegram voice_handler

bot.on('voice', async ctx => {
  const userId = ctx.from.id.toString();
  const WHISPER_API_KEY = process.env.OPENAI_API_KEY || process.env.WHISPER_API_KEY;

  if (!WHISPER_API_KEY) {
    return ctx.reply(
      '🎤 Voice message diterima, tapi transkripsi belum dikonfigurasi.\n' +
      'Set `OPENAI_API_KEY` di environment variables untuk mengaktifkan fitur ini.\n\n' +
      'Ketik pesanmu secara teks ya! 💬'
    );
  }

  try {
    await ctx.sendChatAction('typing');
    const streamer = new DraftStreamer(ctx);
    await streamer.update('🎤 Mengunduh dan mentranskripsikan audio...');

    const voice = ctx.message.voice;
    if (voice.duration > 120) {
      await streamer.clear();
      return ctx.reply('❌ Voice message terlalu panjang (max 2 menit).');
    }

    const audioBuffer = await downloadFile(ctx, voice.file_id);

    // Transcribe with OpenAI Whisper
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
    form.append('model', 'whisper-1');
    form.append('language', 'id'); // Default Indonesian

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHISPER_API_KEY}`,
        ...form.getHeaders()
      },
      body: form
    });

    if (!whisperRes.ok) {
      throw new Error(`Whisper API error: ${whisperRes.status}`);
    }

    const whisperData = await whisperRes.json();
    const transcription = whisperData.text;

    await streamer.clear();

    // Show transcription and process
    await ctx.reply(`🎤 *Transkripsi:*\n"${transcription}"`, { parse_mode: 'Markdown' });
    await handleChat(ctx, transcription);

  } catch (e) {
    console.error('Voice error:', e.message);
    await ctx.reply(`❌ Error transkripsi: ${e.message}`);
  }
});

// ── Error Handler ──────────────────────────────────────────────

bot.catch((err, ctx) => {
  console.error('Bot error:', err.message);
  if (ctx) {
    ctx.reply('❌ Terjadi error internal. Coba lagi ya!').catch(() => {});
  }
});

// ── Bot Command Menu ───────────────────────────────────────────
// Daftar yang muncul di Telegram saat user ketik "/"
async function setupBotCommands() {
  try {
    await bot.telegram.setMyCommands([
      { command: 'start',    description: 'Sambutan & panduan singkat' },
      { command: 'help',     description: 'Bantuan lengkap' },
      { command: 'new',      description: 'Mulai sesi baru (hapus history)' },
      { command: 'stop',     description: 'Hentikan tool loop yang sedang jalan' },
      { command: 'status',   description: 'Status engine & stats' },
      { command: 'verbose',  description: 'Atur level verbose: /verbose 0|1|2' },
      { command: 'memory',   description: 'Lihat memori tersimpan' },
      { command: 'remember', description: 'Simpan ke memori' },
      { command: 'forget',   description: 'Hapus memori (semua atau /forget N)' },
      { command: 'search',   description: 'Cari di memori' },
      { command: 'skills',   description: 'List skill' },
      { command: 'pwd',      description: 'Workspace aktif' },
      { command: 'ls',       description: 'List isi workspace' },
      { command: 'cd',       description: 'Pindah workspace' },
      { command: 'projects', description: 'List project terdaftar' },
      { command: 'git',      description: 'Shortcut git: /git status|log|diff' },
      { command: 'jobs',     description: 'List scheduled job' },
      { command: 'audit',    description: '10 audit entry terakhir' },
      { command: 'export',   description: 'Export session: /export md|json|html' },
      { command: 'clear',    description: 'Alias /new' }
    ]);
  } catch (e) {
    console.error('setMyCommands gagal:', e.message);
  }
}

// ── Launch ──────────────────────────────────────────────────────

// Init notifications service supaya bisa kirim broadcast (webhook, scheduler)
notifications.init({ bot });

bot.launch().then(() => {
  console.log('✅ CPAMC Telegram Bot v3 aktif!');
  console.log(`   Model: ${process.env.MODEL || 'claude-sonnet-4-5'}`);
  console.log(`   Features: Voice=${!!process.env.OPENAI_API_KEY}, Users=${process.env.ALLOWED_USERS || 'all'}`);
  setupBotCommands();

  // Init scheduler kalau diaktifkan
  if (process.env.ENABLE_SCHEDULER === 'true') {
    const scheduler = require('../core/scheduler');
    scheduler.init({ engine, notifications });
    scheduler.start().catch(e => console.error('Scheduler start error:', e.message));
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

module.exports = bot;
