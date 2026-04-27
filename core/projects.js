/**
 * CPAMC Projects / Workspace Registry v3
 *
 * Setara `src/projects/registry.py` di claude-code-telegram:
 * mendaftar workspace yang dikenal bot, untuk command:
 *   /projects     — list semua workspace
 *   /cd <name>    — pindah ke workspace
 *   /pwd          — workspace aktif
 *
 * Disimpan di MongoDB. Ada juga "default" workspace = root /workspace.
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');

const WORKSPACE_ROOT = path.join(__dirname, '..', 'workspace');

if (!fs.existsSync(WORKSPACE_ROOT)) {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
}

function model() {
  if (!db.isReady()) return null;
  return require('./models').Project;
}

function safeResolve(target) {
  const resolved = path.resolve(WORKSPACE_ROOT, target || '.');
  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    throw new Error(`Path "${target}" keluar dari workspace root.`);
  }
  return resolved;
}

class ProjectRegistry {
  /** List semua project terdaftar (db) + folder fisik di workspace/. */
  async list() {
    const M = model();
    let registered = [];
    if (M) {
      registered = await M.find().sort({ name: 1 }).lean();
    }

    // Tambahkan folder fisik di workspace/ yang belum terdaftar
    const physical = [];
    try {
      const entries = fs.readdirSync(WORKSPACE_ROOT, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (registered.some(r => r.path === e.name || r.name === e.name)) continue;
        physical.push({
          name: e.name,
          path: e.name,
          description: '(auto-detected dari workspace/)',
          _source: 'filesystem'
        });
      }
    } catch (e) {
      // ignore
    }

    return [...registered.map(r => ({ ...r, _source: 'mongodb' })), ...physical];
  }

  async get(name) {
    const M = model();
    if (M) {
      const doc = await M.findOne({ name }).lean();
      if (doc) return doc;
    }
    // Fallback: cek apakah folder fisik ada
    const dir = safeResolve(name);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      return { name, path: name, description: '', _source: 'filesystem' };
    }
    return null;
  }

  async register(data) {
    const { name, path: relPath, description = '', triggers = [], createdBy } = data;
    if (!name || !relPath) throw new Error('name dan path wajib diisi.');
    safeResolve(relPath); // validasi
    const M = model();
    if (M) {
      await M.findOneAndUpdate(
        { name },
        { name, path: relPath, description, triggers, createdBy },
        { upsert: true, new: true }
      );
      return true;
    }
    // Tanpa MongoDB tetap bisa lewat folder fisik — cukup pastikan dirnya ada
    const dir = safeResolve(relPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return true;
  }

  async unregister(name) {
    const M = model();
    if (M) {
      await M.deleteOne({ name });
      return true;
    }
    return false;
  }

  /** Resolve a workspace name/relative path to an absolute path inside /workspace. */
  async resolve(name) {
    if (!name || name === '.' || name === '/') return WORKSPACE_ROOT;
    const proj = await this.get(name);
    if (proj) return safeResolve(proj.path);
    return safeResolve(name);
  }

  rootDir() {
    return WORKSPACE_ROOT;
  }

  /** Detect projects by simple keyword match. */
  async detect(message) {
    const M = model();
    if (!M) return [];
    const lower = message.toLowerCase();
    const docs = await M.find({ triggers: { $exists: true, $ne: [] } }).lean();
    return docs
      .filter(d => d.triggers.some(t => lower.includes(t.toLowerCase())))
      .map(d => d.name);
  }
}

module.exports = new ProjectRegistry();
module.exports.WORKSPACE_ROOT = WORKSPACE_ROOT;
