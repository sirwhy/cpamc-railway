/**
 * CPAMC MongoDB Models v3
 * Memory, Session, Session History, Skills
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

// ── Memory ────────────────────────────────────────────────────
const memorySchema = new Schema({
  userId:    { type: String, required: true, index: true },
  content:   { type: String, required: true },
  type:      { type: String, default: 'manual' }, // manual | auto
  tags:      [String],
  createdAt: { type: Date, default: Date.now }
});
memorySchema.index({ userId: 1, createdAt: -1 });
const Memory = mongoose.model('Memory', memorySchema);

// ── Session ───────────────────────────────────────────────────
// Session metadata (bukan history — history disimpan terpisah)
const sessionSchema = new Schema({
  userId:        { type: String, required: true, unique: true },
  platform:      { type: String, default: 'web' },
  activeSkills:  [String],
  messageCount:  { type: Number, default: 0 },
  createdAt:     { type: Date, default: Date.now },
  lastActive:    { type: Date, default: Date.now }
});
const Session = mongoose.model('Session', sessionSchema);

// ── Message / History ─────────────────────────────────────────
// Per-message record untuk context window yang tahan restart
const messageSchema = new Schema({
  userId:    { type: String, required: true, index: true },
  role:      { type: String, enum: ['user', 'assistant', 'system'], required: true },
  content:   { type: Schema.Types.Mixed, required: true }, // String atau array (image)
  timestamp: { type: Date, default: Date.now }
});
messageSchema.index({ userId: 1, timestamp: 1 });
const Message = mongoose.model('Message', messageSchema);

// ── Skills (user-installed) ───────────────────────────────────
const skillSchema = new Schema({
  name:        { type: String, required: true, unique: true },
  description: String,
  triggers:    [String],
  prompt:      { type: String, required: true },
  category:    { type: String, default: 'custom' },
  installedBy: String,
  createdAt:   { type: Date, default: Date.now }
});
const Skill = mongoose.model('Skill', skillSchema);

module.exports = { Memory, Session, Message, Skill };
