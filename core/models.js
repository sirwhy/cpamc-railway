/**
 * CPAMC MongoDB Models v3
 *
 * Collections:
 *   - Memory       — fakta/preferensi user (persisten)
 *   - Session      — metadata sesi user (skill aktif, verbose level, dll.)
 *   - Message      — riwayat chat per user (untuk context window tahan restart)
 *   - Skill        — custom skill yang di-install user
 *   - AuditLog     — log semua command/aksi penting (audit trail)
 *   - WebhookEvent — webhook yang sudah pernah diterima (dedup)
 *   - ScheduledJob — cron job yang dipersist di DB
 *   - Project      — workspace/project yang dikenal bot
 *
 * Semua collection di-namespace per `userId` (Telegram ID atau web ID),
 * jadi memori tiap chat tidak bercampur antar user.
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
const sessionSchema = new Schema({
  userId:        { type: String, required: true, unique: true },
  platform:      { type: String, default: 'web' },
  activeSkills:  [String],
  messageCount:  { type: Number, default: 0 },
  verboseLevel:  { type: Number, default: 1 }, // 0 | 1 | 2
  workspace:     { type: String, default: '.' }, // current workspace dir relatif ke /workspace
  conversationMode: { type: String, default: 'auto' }, // auto | strict | off
  createdAt:     { type: Date, default: Date.now },
  lastActive:    { type: Date, default: Date.now }
});
const Session = mongoose.model('Session', sessionSchema);

// ── Message / History ─────────────────────────────────────────
const messageSchema = new Schema({
  userId:    { type: String, required: true, index: true },
  role:      { type: String, enum: ['user', 'assistant', 'system'], required: true },
  content:   { type: Schema.Types.Mixed, required: true },
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

// ── Audit Log ─────────────────────────────────────────────────
// Setiap command, tool call, dan event keamanan dicatat di sini.
const auditSchema = new Schema({
  userId:    { type: String, required: true, index: true },
  platform:  { type: String, default: 'unknown' },
  action:    { type: String, required: true }, // command | tool_call | webhook | auth | error
  detail:    { type: Schema.Types.Mixed },
  success:   { type: Boolean, default: true },
  timestamp: { type: Date, default: Date.now, index: true }
});
auditSchema.index({ userId: 1, timestamp: -1 });
const AuditLog = mongoose.model('AuditLog', auditSchema);

// ── Webhook Events (dedup) ────────────────────────────────────
// Memastikan satu delivery_id GitHub/provider lain tidak diproses dua kali.
const webhookSchema = new Schema({
  provider:   { type: String, required: true },
  eventType:  { type: String, default: 'unknown' },
  deliveryId: { type: String, required: true },
  payload:    { type: Schema.Types.Mixed },
  processed:  { type: Boolean, default: false },
  receivedAt: { type: Date, default: Date.now }
});
webhookSchema.index({ provider: 1, deliveryId: 1 }, { unique: true });
const WebhookEvent = mongoose.model('WebhookEvent', webhookSchema);

// ── Scheduled Jobs ────────────────────────────────────────────
// Cron-style job yang dipersist ke DB sehingga tahan restart.
const jobSchema = new Schema({
  jobId:           { type: String, required: true, unique: true },
  name:            { type: String, required: true },
  cronExpression:  { type: String, required: true }, // "0 9 * * 1-5"
  prompt:          { type: String, required: true },
  targetChatIds:   [String], // Telegram chat IDs yang menerima output
  workingDirectory: { type: String, default: '.' },
  skillName:       { type: String, default: null },
  enabled:         { type: Boolean, default: true },
  createdBy:       { type: String, default: 'system' },
  lastRunAt:       { type: Date, default: null },
  lastRunStatus:   { type: String, default: null }, // success | error | skipped
  lastRunOutput:   { type: String, default: null },
  createdAt:       { type: Date, default: Date.now }
});
const ScheduledJob = mongoose.model('ScheduledJob', jobSchema);

// ── Project / Workspace Registry ──────────────────────────────
const projectSchema = new Schema({
  name:        { type: String, required: true, unique: true },
  path:        { type: String, required: true }, // path relatif ke WORKSPACE_DIR
  description: { type: String, default: '' },
  triggers:    [String], // keyword opsional untuk auto-switch
  createdBy:   String,
  createdAt:   { type: Date, default: Date.now }
});
const Project = mongoose.model('Project', projectSchema);

module.exports = {
  Memory,
  Session,
  Message,
  Skill,
  AuditLog,
  WebhookEvent,
  ScheduledJob,
  Project
};
