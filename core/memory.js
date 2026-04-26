/**
 * CPAMC Memory Manager v3 — MongoDB + File Fallback
 *
 * Priority:
 *  1. MongoDB (jika MONGODB_URI diset dan terhubung)
 *  2. File lokal JSON (fallback)
 *
 * Hasilnya: memori user TIDAK hilang saat bot restart / redeploy.
 */

const fs   = require('fs');
const path = require('path');
const db   = require('./db');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH  = path.join(DATA_DIR, 'memory.json');

function getModel() {
  if (!db.isReady()) return null;
  return require('./models').Memory;
}

function fileLoad() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {}
  return {};
}
function fileSave(data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  } catch (e) {}
}
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

class MemoryManager {
  async save(userId, content, type = 'manual', tags = []) {
    const M = getModel();
    if (M) {
      const doc = await M.create({ userId, content, type, tags });
      return doc._id.toString();
    }
    const data = fileLoad();
    if (!data[userId]) data[userId] = [];
    const id = genId();
    data[userId].push({ id, content, type, tags, createdAt: new Date().toISOString() });
    if (data[userId].length > 100) data[userId] = data[userId].slice(-100);
    fileSave(data);
    return id;
  }

  async getAll(userId) {
    const M = getModel();
    if (M) {
      const docs = await M.find({ userId }).sort({ createdAt: 1 }).lean();
      return docs.map(d => ({ id: d._id.toString(), content: d.content, type: d.type, tags: d.tags, createdAt: d.createdAt }));
    }
    return fileLoad()[userId] || [];
  }

  async getRecent(userId, n = 5) {
    const M = getModel();
    if (M) {
      const docs = await M.find({ userId }).sort({ createdAt: -1 }).limit(n).lean();
      return docs.reverse().map(d => ({ id: d._id.toString(), content: d.content, type: d.type }));
    }
    const all = fileLoad()[userId] || [];
    return all.slice(-n);
  }

  async search(userId, query) {
    const M = getModel();
    if (M) {
      const q = new RegExp(query, 'i');
      const docs = await M.find({ userId, $or: [{ content: q }, { tags: q }] }).sort({ createdAt: -1 }).lean();
      return docs.map(d => ({ id: d._id.toString(), content: d.content, type: d.type, tags: d.tags }));
    }
    const q = query.toLowerCase();
    return (fileLoad()[userId] || []).filter(m =>
      m.content.toLowerCase().includes(q) || (m.tags && m.tags.some(t => t.toLowerCase().includes(q)))
    );
  }

  async delete(id) {
    const M = getModel();
    if (M) { try { await M.findByIdAndDelete(id); } catch (e) {} return; }
    const data = fileLoad();
    for (const u in data) data[u] = data[u].filter(m => m.id !== id);
    fileSave(data);
  }

  async deleteAll(userId) {
    const M = getModel();
    if (M) { await M.deleteMany({ userId }); return; }
    const data = fileLoad();
    data[userId] = [];
    fileSave(data);
  }

  async autoExtract(userId, userMsg) {
    const patterns = [
      { re: /nama saya ([\w\s]+)/i,               label: 'Nama user'   },
      { re: /my name is ([\w\s]+)/i,               label: 'User name'   },
      { re: /saya (?:tinggal|dari)(?: di)? ([\w\s]+)/i, label: 'Lokasi' },
      { re: /i (?:live|am from)(?: in)? ([\w\s]+)/i,    label: 'Location' },
      { re: /tolong ingat[,:]?\s*(.+)/i,           label: 'Catatan'    },
      { re: /please remember[,:]?\s*(.+)/i,        label: 'Note'       },
      { re: /saya suka (.+)/i,                     label: 'Preferensi' },
      { re: /i (?:like|prefer|love) (.+)/i,        label: 'Preference' },
      { re: /project(?:ku)? (?:adalah|is) ([\w\s]+)/i, label: 'Project' },
    ];
    for (const p of patterns) {
      const m = userMsg.match(p.re);
      if (m && m[1] && m[1].trim().length < 100) {
        await this.save(userId, `${p.label}: ${m[1].trim()}`, 'auto').catch(() => {});
      }
    }
  }

  async stats() {
    const M = getModel();
    if (M) {
      const total = await M.countDocuments();
      const users = await M.distinct('userId');
      return { users: users.length, total, backend: 'mongodb' };
    }
    const data = fileLoad();
    return {
      users: Object.keys(data).length,
      total: Object.values(data).reduce((a, b) => a + b.length, 0),
      backend: 'file'
    };
  }
}

module.exports = new MemoryManager();
