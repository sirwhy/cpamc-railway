/**
 * CPAMC Skill Manager v3 — Built-in (file) + Custom (MongoDB)
 *
 * Built-in skills: dibaca dari folder /skills/*.json (selalu ada)
 * Custom/user skills: disimpan di MongoDB (atau file fallback)
 */

const fs   = require('fs');
const path = require('path');
const db   = require('./db');

const BUILTIN_DIR = path.join(__dirname, '..', 'skills');
const USER_DIR    = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'skills')
  : path.join(__dirname, '..', 'data', 'skills');

function getModel() {
  if (!db.isReady()) return null;
  return require('./models').Skill;
}

class SkillManager {
  constructor() {
    this.builtins = {}; // dari file, selalu tersedia
  }

  // Load built-in skills dari file (sync, sekali saat boot)
  loadBuiltins() {
    this.builtins = {};
    if (!fs.existsSync(BUILTIN_DIR)) return;
    fs.readdirSync(BUILTIN_DIR)
      .filter(f => f.endsWith('.json'))
      .forEach(f => {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(BUILTIN_DIR, f), 'utf8'));
          if (s.name && s.prompt) this.builtins[s.name] = { ...s, _source: 'builtin' };
        } catch (e) {}
      });
  }

  // Load user skills dari file fallback
  _loadUserFromFile() {
    const skills = {};
    if (!fs.existsSync(USER_DIR)) return skills;
    fs.readdirSync(USER_DIR)
      .filter(f => f.endsWith('.json'))
      .forEach(f => {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(USER_DIR, f), 'utf8'));
          if (s.name && s.prompt) skills[s.name] = { ...s, _source: 'user' };
        } catch (e) {}
      });
    return skills;
  }

  async list() {
    const M = getModel();
    let userSkills = {};
    if (M) {
      const docs = await M.find().lean();
      docs.forEach(d => { userSkills[d.name] = { ...d, _source: 'mongodb' }; });
    } else {
      userSkills = this._loadUserFromFile();
    }
    return Object.values({ ...this.builtins, ...userSkills });
  }

  async get(name) {
    // Check builtins first
    if (this.builtins[name]) return this.builtins[name];
    const M = getModel();
    if (M) {
      const doc = await M.findOne({ name }).lean();
      return doc || null;
    }
    const userSkills = this._loadUserFromFile();
    return userSkills[name] || null;
  }

  async exists(name) {
    if (this.builtins[name]) return true;
    const M = getModel();
    if (M) return !!(await M.findOne({ name }).lean());
    return !!this._loadUserFromFile()[name];
  }

  async detect(message) {
    const lower = message.toLowerCase();
    const allSkills = await this.list();
    return allSkills
      .filter(s => s.triggers && s.triggers.some(t => lower.includes(t.toLowerCase())))
      .map(s => s.name);
  }

  async install(skillData) {
    const M = getModel();
    if (M) {
      await M.findOneAndUpdate(
        { name: skillData.name },
        { ...skillData },
        { upsert: true, new: true }
      );
      return true;
    }
    // File fallback
    fs.mkdirSync(USER_DIR, { recursive: true });
    const fname = skillData.name.replace(/\s+/g, '_') + '.json';
    fs.writeFileSync(path.join(USER_DIR, fname), JSON.stringify(skillData, null, 2));
    return true;
  }

  async uninstall(name) {
    // Jangan hapus builtin
    if (this.builtins[name]) return false;
    const M = getModel();
    if (M) { await M.deleteOne({ name }); return true; }
    const fname = name.replace(/\s+/g, '_') + '.json';
    const p = path.join(USER_DIR, fname);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  }
}

const mgr = new SkillManager();
mgr.loadBuiltins(); // sync load saat boot
module.exports = mgr;
