/**
 * CPAMC Engine v3 — Full Agentic Engine + MongoDB Persistence
 *
 * Yang disimpan di MongoDB:
 *   - Memory per user (facts, notes, preferensi)
 *   - Session metadata (skills aktif, statistik)
 *   - Message history (seluruh percakapan, tahan restart)
 *   - Custom skills
 *
 * Fallback ke file JSON jika MongoDB tidak tersedia.
 */

const fetch  = require('node-fetch');
require('dotenv').config();

const db      = require('./db');
const memory  = require('./memory');
const skills  = require('./skills');
const RateLimiter = require('./rate_limiter');
const tools   = require('./tools');

const CPAMC_URL   = process.env.CPAMC_BASE_URL || 'https://cli-proxy-api-production-9440.up.railway.app/v1';
const CPAMC_KEY   = process.env.CPAMC_API_KEY  || 'dummy';
const MAX_TOKENS  = parseInt(process.env.MAX_TOKENS  || '4096');
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || '0.7');
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY  || '60');

const modelDetector = require('./model_detector');

// In-memory cache sesi (sinkron dengan DB)
const sessionCache = {};

function getModels() {
  if (!db.isReady()) return null;
  return require('./models');
}

// ── Session Helpers ──────────────────────────────────────────

async function loadSession(userId, platform = 'web') {
  if (sessionCache[userId]) {
    sessionCache[userId].lastActive = Date.now();
    return sessionCache[userId];
  }

  const M = getModels();
  let meta = null;
  let history = [];

  if (M) {
    // Load atau buat session doc
    meta = await M.Session.findOneAndUpdate(
      { userId },
      { $set: { lastActive: new Date(), platform } },
      { upsert: true, new: true }
    ).lean();

    // Load history dari DB (max MAX_HISTORY pesan terakhir)
    const msgs = await M.Message.find({ userId })
      .sort({ timestamp: -1 })
      .limit(MAX_HISTORY)
      .lean();
    history = msgs.reverse().map(m => ({ role: m.role, content: m.content }));
  }

  sessionCache[userId] = {
    userId,
    platform: meta?.platform || platform,
    history,
    activeSkills: meta?.activeSkills || [],
    messageCount: meta?.messageCount || 0,
    createdAt: meta?.createdAt ? new Date(meta.createdAt).getTime() : Date.now(),
    lastActive: Date.now()
  };

  return sessionCache[userId];
}

async function saveMessage(userId, role, content) {
  const M = getModels();
  if (M) {
    await M.Message.create({ userId, role, content }).catch(() => {});
    // Trim jika terlalu banyak
    const count = await M.Message.countDocuments({ userId });
    if (count > MAX_HISTORY + 10) {
      const oldest = await M.Message.find({ userId })
        .sort({ timestamp: 1 })
        .limit(count - MAX_HISTORY)
        .select('_id')
        .lean();
      await M.Message.deleteMany({ _id: { $in: oldest.map(d => d._id) } });
    }
  }
}

async function saveSessionMeta(session) {
  const M = getModels();
  if (M) {
    await M.Session.updateOne(
      { userId: session.userId },
      { $set: { activeSkills: session.activeSkills, messageCount: session.messageCount, lastActive: new Date() } }
    ).catch(() => {});
  }
}

// ── Exports ───────────────────────────────────────────────────

function clearSessionCache(userId) {
  if (sessionCache[userId]) {
    sessionCache[userId].history      = [];
    sessionCache[userId].activeSkills = [];
    sessionCache[userId].messageCount = 0;
  }
}

async function clearSessionDB(userId) {
  clearSessionCache(userId);
  const M = getModels();
  if (M) {
    await M.Message.deleteMany({ userId }).catch(() => {});
    await M.Session.updateOne({ userId }, { $set: { messageCount: 0, activeSkills: [] } }).catch(() => {});
  }
}

function getSessionFromCache(userId) {
  return sessionCache[userId] || null;
}

// ── System Prompt ─────────────────────────────────────────────

async function buildSystemPrompt(session) {
  let sys = `Kamu adalah CPAMC AI - Asisten Cerdas Otonom yang powerful.
Kamu bisa bertindak sebagai software engineer, analyst, creative writer, translator, dan lebih.
Platform: ${session.platform} | Waktu: ${new Date().toLocaleString('id-ID')} | Model: ${await modelDetector.getActiveModel()}

== TOOLS TERSEDIA ==
Gunakan tools berikut HANYA jika benar-benar diperlukan (jangan untuk pertanyaan biasa):

1. execute_command - Jalankan perintah bash di workspace
   args: {"command": "..."}

2. read_file - Baca isi file di workspace
   args: {"filepath": "..."}

3. write_file - Buat/edit file di workspace
   args: {"filepath": "...", "content": "..."}

4. list_dir - Lihat isi direktori di workspace
   args: {"dirpath": "..."}

5. delete_file - Hapus file di workspace
   args: {"filepath": "..."}

6. git_status - Cek status git di workspace
   args: {}

7. git_log - Lihat history commit
   args: {"limit": 10}

8. git_diff - Lihat perubahan file
   args: {"filepath": "optional"}

== FORMAT TOOL CALL ==
Untuk memanggil tool, balas HANYA dengan format XML ini (tanpa teks lain):
<tool_call>
{"name": "nama_tool", "args": {"key": "value"}}
</tool_call>

Tunggu <tool_response> sebelum lanjut.

== PANDUAN ==
- Jawab dalam bahasa yang sama dengan pertanyaan user
- Untuk coding: berikan kode lengkap dan jelaskan
- Untuk analisis: gunakan data konkret
- Untuk kreativitas: ekspresif dan orisinal
- Selalu professional dan helpful
`;

  // Active skills
  if (session.activeSkills.length > 0) {
    sys += `\n== SKILL AKTIF ==\n`;
    for (const sn of session.activeSkills) {
      const sk = await skills.get(sn);
      if (sk) sys += `[${sk.name}]\n${sk.prompt}\n\n`;
    }
  }

  // Recent memories
  const mems = await memory.getRecent(session.userId, 8);
  if (mems.length > 0) {
    sys += `\n== MEMORI USER ==\n`;
    mems.forEach(m => { sys += `- ${m.content}\n`; });
  }

  return sys;
}

// ── Command Handler ───────────────────────────────────────────

const rateLimiter = new RateLimiter({ capacity: 15, refillRate: 0.5 });

async function handleCommand(session, msg) {
  const cmd = msg.trim();
  const lower = cmd.toLowerCase();

  if (['/clear', '!clear'].includes(lower)) {
    await clearSessionDB(session.userId);
    return { text: '✓ History chat dihapus dari database.', isCommand: true };
  }

  if (['/memory', '!memory'].includes(lower)) {
    const mems = await memory.getAll(session.userId);
    if (!mems.length) return { text: 'Belum ada memori tersimpan.', isCommand: true };
    const list = mems.map((m, i) => `${i + 1}. [${m.type}] ${m.content}`).join('\n');
    return { text: `📝 *Memori (${mems.length}):*\n${list}`, isCommand: true };
  }

  if (['/skills', '!skills'].includes(lower)) {
    const all = await skills.list();
    if (!all.length) return { text: 'Tidak ada skill tersedia.', isCommand: true };
    let text = `🔧 *Skills (${all.length}):*\n`;
    all.forEach(s => {
      const on = session.activeSkills.includes(s.name);
      text += `${on ? '✅' : '⭕'} *${s.name}* — ${s.description || ''}\n`;
    });
    text += `\nKetik: /skill <nama> untuk toggle`;
    return { text, isCommand: true };
  }

  if (lower.startsWith('/skill ') || lower.startsWith('!skill ')) {
    const name = cmd.split(' ').slice(1).join(' ').trim();
    if (!(await skills.exists(name)))
      return { text: `❌ Skill "${name}" tidak ditemukan.\nGunakan /skills untuk melihat daftar.`, isCommand: true };
    if (session.activeSkills.includes(name)) {
      session.activeSkills = session.activeSkills.filter(s => s !== name);
      await saveSessionMeta(session);
      return { text: `⭕ Skill *${name}* dinonaktifkan.`, isCommand: true };
    } else {
      session.activeSkills.push(name);
      await saveSessionMeta(session);
      return { text: `✅ Skill *${name}* diaktifkan.`, isCommand: true };
    }
  }

  if (lower.startsWith('/remember ') || lower.startsWith('!remember ')) {
    const val = cmd.split(' ').slice(1).join(' ');
    await memory.save(session.userId, val, 'manual');
    return { text: `✓ Tersimpan: "${val}"`, isCommand: true };
  }

  if (lower.startsWith('/forget')) {
    const parts = cmd.split(' ');
    if (parts[1] && !isNaN(parseInt(parts[1]))) {
      const idx  = parseInt(parts[1]) - 1;
      const mems = await memory.getAll(session.userId);
      if (mems[idx]) {
        await memory.delete(mems[idx].id);
        return { text: `✓ Memori #${idx + 1} dihapus.`, isCommand: true };
      }
      return { text: `❌ Memori #${parts[1]} tidak ditemukan.`, isCommand: true };
    } else {
      await memory.deleteAll(session.userId);
      return { text: '✓ Semua memori dihapus.', isCommand: true };
    }
  }

  if (lower.startsWith('/search ') || lower.startsWith('!search ')) {
    const query   = cmd.split(' ').slice(1).join(' ');
    const results = await memory.search(session.userId, query);
    if (!results.length) return { text: `Tidak ditemukan memori untuk: "${query}"`, isCommand: true };
    const list = results.map((m, i) => `${i + 1}. [${m.type}] ${m.content}`).join('\n');
    return { text: `🔍 *Hasil pencarian "${query}":*\n${list}`, isCommand: true };
  }

  if (['/status', '!status'].includes(lower)) {
    const mems        = await memory.getAll(session.userId);
    const memStats    = await memory.stats();
    const rateStatus  = rateLimiter.getStatus(session.userId);
    const activeModel = await modelDetector.getActiveModel();
    const modelInfo   = modelDetector.getInfo();
    const modelList   = modelInfo.available.slice(0, 5).join(', ') + (modelInfo.total > 5 ? ` (+${modelInfo.total - 5} lainnya)` : '');
    return {
      text: `📊 *Status CPAMC AI v3*\n\n` +
        `🤖 Model aktif : ${activeModel}\n` +
        `🔍 Sumber model: ${modelInfo.source === 'auto-detect' ? 'auto 9router' : 'manual (env)'}\n` +
        `📋 Model tersedia: ${modelList || '-'}\n` +
        `🌐 API         : ${CPAMC_URL}\n` +
        `💾 Database    : ${memStats.backend === 'mongodb' ? '✅ MongoDB' : '📁 File lokal'}\n` +
        `📝 Memori      : ${mems.length} item\n` +
        `🔧 Skills aktif: ${session.activeSkills.join(', ') || 'none'}\n` +
        `💬 History     : ${session.history.length} pesan\n` +
        `⚡ Rate limit   : ${rateStatus.tokens}/${rateStatus.capacity} token\n` +
        `🕐 Aktif sejak  : ${new Date(session.createdAt).toLocaleString('id-ID')}`,
      isCommand: true
    };
  }

  if (['/help', '!help'].includes(lower)) {
    return {
      text: `🤖 *CPAMC AI v3 - Help*\n\n` +
        `*Commands:*\n` +
        `/skills — lihat semua skill\n` +
        `/skill <nama> — aktifkan/matikan skill\n` +
        `/memory — lihat memori\n` +
        `/remember <teks> — simpan ke memori\n` +
        `/forget [nomor] — hapus memori\n` +
        `/search <query> — cari di memori\n` +
        `/export [md|json|html] — export session\n` +
        `/clear — hapus history chat\n` +
        `/status — info engine & stats\n\n` +
        `*File & Media:*\n` +
        `📎 Upload file → analisis otomatis\n` +
        `🖼️ Upload gambar → analisis visual\n` +
        `🎤 Kirim voice → transkripsi\n\n` +
        `*Agentic Mode:*\n` +
        `Bot otomatis menggunakan tools untuk eksekusi kode, file, git`,
      isCommand: true
    };
  }

  if (lower.startsWith('/export')) {
    const parts  = cmd.split(' ');
    const format = parts[1] || 'markdown';
    return { text: null, isCommand: true, export: format };
  }

  return null;
}

// ── Main Chat ─────────────────────────────────────────────────

async function chat(userId, userMessage, options = {}) {
  const { platform = 'web', onStatus, imageBase64 = null, imageType = null } = options;

  const session = await loadSession(userId, platform);

  // Rate limiting untuk Telegram
  if (platform === 'telegram') {
    const rateCheck = rateLimiter.check(userId);
    if (!rateCheck.allowed) return { text: rateCheck.message, isRateLimited: true };
  }

  // Handle command
  const cmdResult = await handleCommand(session, userMessage);
  if (cmdResult !== null) {
    if (cmdResult.export) {
      const sessionExport = require('./session_export');
      const exported = sessionExport.export(session.history, cmdResult.export, userId);
      return { text: `✓ Session di-export ke format ${cmdResult.export}.`, exported };
    }
    return cmdResult;
  }

  // Auto-detect skills
  const detected = await skills.detect(userMessage);
  if (detected.length > 0) {
    const before = session.activeSkills.length;
    session.activeSkills = [...new Set([...session.activeSkills, ...detected])];
    if (session.activeSkills.length !== before) await saveSessionMeta(session);
  }

  // Build user content
  let userContent;
  if (imageBase64 && imageType) {
    userContent = [
      { type: 'image_url', image_url: { url: `data:${imageType};base64,${imageBase64}` } },
      { type: 'text', text: userMessage }
    ];
  } else {
    userContent = userMessage;
  }

  // Push ke history cache + DB
  session.history.push({ role: 'user', content: userContent });
  session.messageCount++;
  await saveMessage(userId, 'user', userContent);

  // Trim in-memory (DB sudah di-trim saat saveMessage)
  if (session.history.length > MAX_HISTORY) {
    session.history = session.history.slice(-MAX_HISTORY);
  }

  // Agentic loop
  let loopCount = 0;
  const MAX_LOOPS = 10;
  let finalReply = '';

  while (loopCount < MAX_LOOPS) {
    loopCount++;
    const systemPrompt = await buildSystemPrompt(session);

    let response;
    try {
      response = await fetch(`${CPAMC_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CPAMC_KEY}`
        },
        body: JSON.stringify({
          model: await modelDetector.getActiveModel(),
          messages: [
            { role: 'system', content: systemPrompt },
            ...session.history.map(m => ({
              role: m.role,
              content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
            }))
          ],
          max_tokens:  MAX_TOKENS,
          stream:      false,
          temperature: TEMPERATURE
        })
      });
    } catch (e) {
      throw new Error(`API fetch error: ${e.message}`);
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API ${response.status}: ${errText}`);
    }

    const data  = await response.json();
    const reply = data.choices?.[0]?.message?.content || 'Tidak ada respons.';

    session.history.push({ role: 'assistant', content: reply });
    await saveMessage(userId, 'assistant', reply);

    // Check tool call
    const toolMatch = reply.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/);
    if (toolMatch) {
      try {
        const toolData = JSON.parse(toolMatch[1]);
        if (onStatus) {
          const preview = toolData.args?.command?.slice(0, 40) || toolData.args?.filepath || '';
          await onStatus(`⚙️ ${toolData.name}${preview ? ` (${preview})` : ''}...`);
        }

        if (tools[toolData.name]) {
          const toolResult = await tools[toolData.name](toolData.args || {});
          const toolMsg = `<tool_response>\n${toolResult}\n</tool_response>\nSilakan lanjutkan atau berikan jawaban final.`;
          session.history.push({ role: 'user', content: toolMsg });
          await saveMessage(userId, 'user', toolMsg);
          continue;
        } else {
          const toolMsg = `<tool_response>\nError: Tool "${toolData.name}" tidak dikenal.\nTools tersedia: ${Object.keys(tools).join(', ')}\n</tool_response>`;
          session.history.push({ role: 'user', content: toolMsg });
          await saveMessage(userId, 'user', toolMsg);
          continue;
        }
      } catch (e) {
        const toolMsg = `<tool_response>\nError parsing tool call: ${e.message}\n</tool_response>`;
        session.history.push({ role: 'user', content: toolMsg });
        await saveMessage(userId, 'user', toolMsg);
        continue;
      }
    }

    finalReply = reply;
    break;
  }

  if (loopCount >= MAX_LOOPS) finalReply += '\n\n_[Sistem: Batas loop agentic tercapai]_';

  // Auto-extract memory
  await memory.autoExtract(userId, userMessage);

  return {
    text:      finalReply,
    model:     await modelDetector.getActiveModel(),
    skills:    session.activeSkills,
    loopCount
  };
}

// ── Stats ─────────────────────────────────────────────────────

async function getStats() {
  const memStats = await memory.stats().catch(() => ({ users: 0, total: 0, backend: 'unknown' }));
  const allSkills = await skills.list().catch(() => []);
  const M = getModels();
  let sessionCount = Object.keys(sessionCache).length;
  if (M) {
    sessionCount = await M.Session.countDocuments().catch(() => sessionCount);
  }
  return {
    sessions:  sessionCount,
    activeSessions: Object.values(sessionCache).filter(s => Date.now() - s.lastActive < 3600000).length,
    memory:    memStats,
    skills:    allSkills.length,
    model:     await modelDetector.getActiveModel(),
    modelInfo: modelDetector.getInfo(),
    apiUrl:    CPAMC_URL,
    uptime:    process.uptime(),
    database:  db.isReady() ? 'mongodb' : 'file'
  };
}

module.exports = {
  chat,
  getStats,
  getSession:    (userId) => sessionCache[userId] || null,
  clearSession:  clearSessionDB,
  memory,
  skills,
  db,
  loadSession
};
