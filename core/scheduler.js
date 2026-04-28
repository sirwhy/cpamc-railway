/**
 * CPAMC Scheduler v3
 *
 * Setara `src/scheduler/scheduler.py` di claude-code-telegram.
 * Cron-style job runner berbasis `node-cron`, tahan restart karena job
 * dipersist di MongoDB (collection ScheduledJob).
 *
 * Saat job fire:
 *   1. Engine.chat dipanggil dengan prompt yang tersimpan
 *   2. Hasil dikirim ke setiap targetChatId via NotificationService
 *   3. Hasil + status disimpan kembali ke ScheduledJob (lastRunAt, lastRunStatus)
 *
 * Format cron: standard 5-field cron — "menit jam tanggal bulan hari"
 *   "0 9 * * 1-5"  → setiap hari kerja jam 09:00
 *   "*\/15 * * * *" → setiap 15 menit
 */

const cron = require('node-cron');
const db = require('./db');
const audit = require('./audit');

function model() {
  if (!db.isReady()) return null;
  return require('./models').ScheduledJob;
}

class JobScheduler {
  constructor() {
    this.tasks = new Map(); // jobId → cron.ScheduledTask
    this.engine = null;
    this.notifications = null;
    this.started = false;
  }

  init({ engine, notifications }) {
    this.engine = engine;
    this.notifications = notifications;
  }

  async start() {
    if (this.started) return;
    this.started = true;

    const M = model();
    if (!M) {
      console.warn('⚠️  Scheduler aktif tanpa MongoDB — job tidak akan persist.');
      return;
    }

    const jobs = await M.find({ enabled: true }).lean();
    for (const job of jobs) {
      this._scheduleTask(job);
    }
    console.log(`✅ Scheduler aktif — ${jobs.length} job dimuat dari DB`);
  }

  async stop() {
    for (const task of this.tasks.values()) {
      try { task.stop(); } catch (e) {}
    }
    this.tasks.clear();
    this.started = false;
  }

  _scheduleTask(job) {
    if (!cron.validate(job.cronExpression)) {
      console.error(`❌ Cron invalid untuk job "${job.name}": ${job.cronExpression}`);
      return null;
    }
    if (this.tasks.has(job.jobId)) {
      try { this.tasks.get(job.jobId).stop(); } catch (e) {}
      this.tasks.delete(job.jobId);
    }
    const task = cron.schedule(job.cronExpression, () => this._fire(job).catch(e => {
      console.error(`Job "${job.name}" error:`, e.message);
    }), { timezone: process.env.TZ || 'Asia/Jakarta' });
    this.tasks.set(job.jobId, task);
    return task;
  }

  async _fire(job) {
    const M = model();
    if (!this.engine) {
      console.warn(`Job "${job.name}" fire — engine belum ter-init.`);
      return;
    }

    let status = 'success';
    let output = '';

    try {
      const sysUserId = `scheduler:${job.jobId}`;
      const promptToRun = job.skillName
        ? `[Skill: ${job.skillName}]\n${job.prompt}`
        : job.prompt;

      const res = await this.engine.chat(sysUserId, promptToRun, {
        platform: 'scheduler',
        workspace: job.workingDirectory || '.'
      });
      output = res.text || '(tidak ada output)';

      // Broadcast ke target chat
      if (this.notifications && Array.isArray(job.targetChatIds)) {
        const header = `⏰ *${job.name}*\n_Cron: ${job.cronExpression}_\n\n`;
        for (const chatId of job.targetChatIds) {
          await this.notifications.send(chatId, header + output).catch(() => {});
        }
      }
    } catch (e) {
      status = 'error';
      output = e.message;
      console.error(`Scheduler job "${job.name}" failed:`, e.message);
    }

    if (M) {
      await M.updateOne(
        { jobId: job.jobId },
        { $set: { lastRunAt: new Date(), lastRunStatus: status, lastRunOutput: output.slice(0, 4000) } }
      ).catch(() => {});
    }

    await audit.log('scheduler', 'job_run', {
      jobId: job.jobId,
      name: job.name,
      status,
      outputPreview: output.slice(0, 200)
    }, { platform: 'scheduler', success: status === 'success' });
  }

  async addJob(data) {
    const {
      name, cronExpression, prompt,
      targetChatIds = [], workingDirectory = '.', skillName = null,
      createdBy = 'system'
    } = data;
    if (!name || !cronExpression || !prompt) {
      throw new Error('name, cronExpression, dan prompt wajib diisi.');
    }
    if (!cron.validate(cronExpression)) {
      throw new Error(`Cron expression invalid: ${cronExpression}`);
    }

    const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const job = {
      jobId, name, cronExpression, prompt,
      targetChatIds: targetChatIds.map(String),
      workingDirectory, skillName, createdBy,
      enabled: true
    };

    const M = model();
    if (M) {
      await M.create(job);
    }
    this._scheduleTask(job);
    await audit.log(createdBy, 'scheduler_add', { jobId, name, cronExpression });
    return jobId;
  }

  async removeJob(jobId) {
    const task = this.tasks.get(jobId);
    if (task) {
      try { task.stop(); } catch (e) {}
      this.tasks.delete(jobId);
    }
    const M = model();
    if (M) await M.deleteOne({ jobId });
    await audit.log('system', 'scheduler_remove', { jobId });
    return true;
  }

  async toggleJob(jobId, enabled) {
    const M = model();
    if (M) await M.updateOne({ jobId }, { $set: { enabled } });

    const task = this.tasks.get(jobId);
    if (!enabled && task) {
      task.stop();
      this.tasks.delete(jobId);
    } else if (enabled && !task && M) {
      const job = await M.findOne({ jobId }).lean();
      if (job) this._scheduleTask(job);
    }
    return true;
  }

  async listJobs() {
    const M = model();
    if (!M) return Array.from(this.tasks.keys()).map(id => ({ jobId: id, _source: 'memory' }));
    return M.find().sort({ createdAt: -1 }).lean();
  }

  async getJob(jobId) {
    const M = model();
    if (!M) return null;
    return M.findOne({ jobId }).lean();
  }
}

module.exports = new JobScheduler();
