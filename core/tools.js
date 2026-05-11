/**
 * CPAMC Tools v3
 * Sandbox tools untuk eksekusi agentic.
 *
 * Setiap tool call wajib di-scope ke direktori workspace (default `/workspace`)
 * untuk mencegah path traversal. Per-session workspace bisa dipilih dengan
 * argumen `_workspace` (relative path dari WORKSPACE_ROOT).
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');

const hermes = require('./hermes');

const execAsync = util.promisify(exec);

const WORKSPACE_ROOT = path.join(__dirname, '..', 'workspace');

if (!fs.existsSync(WORKSPACE_ROOT)) {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
}

function resolveCwd(workspace) {
  if (!workspace || workspace === '.' || workspace === '/') return WORKSPACE_ROOT;
  const resolved = path.resolve(WORKSPACE_ROOT, workspace);
  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    throw new Error('Workspace keluar dari root yang diizinkan.');
  }
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

function resolvePath(targetPath, workspace) {
  const cwd = resolveCwd(workspace);
  const resolved = path.resolve(cwd, targetPath || '');
  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    throw new Error('Akses ditolak. Hanya boleh mengakses folder workspace.');
  }
  return resolved;
}

const tools = {
  execute_command: async (args) => {
    try {
      const { command, _workspace } = args;
      if (!command) return "Error: Parameter 'command' tidak ditemukan.";
      const cwd = resolveCwd(_workspace);
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: 30000,
        maxBuffer: 5 * 1024 * 1024
      });
      let result = '';
      if (stdout) result += `STDOUT:\n${stdout}\n`;
      if (stderr) result += `STDERR:\n${stderr}\n`;
      return result || 'Command berhasil dieksekusi tanpa output.';
    } catch (e) {
      return `Error eksekusi command: ${e.message}\n${e.stderr || ''}`;
    }
  },

  read_file: async (args) => {
    try {
      const { filepath, _workspace } = args;
      if (!filepath) return "Error: Parameter 'filepath' tidak ditemukan.";
      const fullPath = resolvePath(filepath, _workspace);
      if (!fs.existsSync(fullPath)) return `Error: File ${filepath} tidak ditemukan.`;
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.length > 20000) {
        return content.slice(0, 20000) + '\n...[terpotong, file terlalu besar]';
      }
      return content;
    } catch (e) {
      return `Error membaca file: ${e.message}`;
    }
  },

  write_file: async (args) => {
    try {
      const { filepath, content, _workspace } = args;
      if (!filepath || content === undefined)
        return "Error: Parameter 'filepath' dan 'content' wajib diisi.";
      const fullPath = resolvePath(filepath, _workspace);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(fullPath, content, 'utf8');
      return `✓ Berhasil menulis ke ${filepath}`;
    } catch (e) {
      return `Error menulis file: ${e.message}`;
    }
  },

  list_dir: async (args) => {
    try {
      const { dirpath = '.', _workspace } = args;
      const fullPath = resolvePath(dirpath, _workspace);
      if (!fs.existsSync(fullPath)) return `Error: Direktori ${dirpath} tidak ditemukan.`;
      const files = fs.readdirSync(fullPath, { withFileTypes: true });
      const result = files
        .map(f => {
          if (f.isDirectory()) return `[DIR]  ${f.name}/`;
          const stat = fs.statSync(path.join(fullPath, f.name));
          const size = stat.size > 1024 ? `${(stat.size / 1024).toFixed(1)}KB` : `${stat.size}B`;
          return `[FILE] ${f.name} (${size})`;
        })
        .join('\n');
      return result || '(Direktori kosong)';
    } catch (e) {
      return `Error membaca direktori: ${e.message}`;
    }
  },

  delete_file: async (args) => {
    try {
      const { filepath, _workspace } = args;
      if (!filepath) return "Error: Parameter 'filepath' tidak ditemukan.";
      const fullPath = resolvePath(filepath, _workspace);
      if (!fs.existsSync(fullPath)) return `Error: File ${filepath} tidak ditemukan.`;
      fs.unlinkSync(fullPath);
      return `✓ File ${filepath} dihapus.`;
    } catch (e) {
      return `Error menghapus file: ${e.message}`;
    }
  },

  // Git operations
  git_status: async (args) => {
    try {
      const cwd = resolveCwd(args._workspace);
      const { stdout } = await execAsync('git status --short', { cwd });
      const { stdout: branch } = await execAsync('git branch --show-current', { cwd });
      return `Branch: ${branch.trim()}\n${stdout || '(working directory clean)'}`;
    } catch (e) {
      return `Git error: ${e.message}`;
    }
  },

  git_log: async (args) => {
    try {
      const limit = args.limit || 10;
      const cwd = resolveCwd(args._workspace);
      const { stdout } = await execAsync(`git log --oneline -${limit}`, { cwd });
      return stdout || '(no commits yet)';
    } catch (e) {
      return `Git error: ${e.message}`;
    }
  },

  git_diff: async (args) => {
    try {
      const { filepath, _workspace } = args;
      const cwd = resolveCwd(_workspace);
      const cmd = filepath ? `git diff ${filepath}` : 'git diff';
      const { stdout } = await execAsync(cmd, { cwd });
      if (!stdout) return '(no changes)';
      if (stdout.length > 10000) return stdout.slice(0, 10000) + '\n...[diff terpotong]';
      return stdout;
    } catch (e) {
      return `Git error: ${e.message}`;
    }
  },

  // ── Hermes (music producer) — talk to GPU worker ───────────────
  // Worker runs Demucs / Whisper / XTTS / RVC / ffmpeg on AWS VPS.
  // Bot side hanya proxy HTTP + push media artifacts ke Telegram.

  hermes_voices: async (args) => {
    try {
      if (!hermes.isConfigured()) return hermes.configError();
      const data = await hermes.listVoices();
      const voices = Array.isArray(data) ? data : data.voices || [];
      if (!voices.length) return '(Worker tidak punya voice model. Daftarkan via hermes_upload_voice.)';
      return JSON.stringify({ voices }, null, 2);
    } catch (e) {
      return `Error hermes_voices: ${e.message}`;
    }
  },

  hermes_cover: async (args) => {
    try {
      if (!hermes.isConfigured()) return hermes.configError();
      const {
        source_url,
        source_file_id,
        mode,
        target_language,
        voice_target,
        voice_pitch_shift,
        voice_strength,
        output_bundle,
        user_id,
        _userId
      } = args;

      if (!mode) return "Error: parameter 'mode' wajib (ai_cover | translation_cover | stems_only | transcribe_only).";
      if (!source_url && !source_file_id) return "Error: salah satu dari 'source_url' atau 'source_file_id' wajib diisi.";
      if (mode === 'translation_cover' && !target_language) return "Error: 'target_language' wajib untuk mode translation_cover.";

      const payload = {
        source_url: source_url || null,
        source_file_id: source_file_id || null,
        mode,
        target_language: target_language || null,
        voice_target: voice_target || 'preserve_original',
        voice_pitch_shift: Number.isFinite(voice_pitch_shift) ? voice_pitch_shift : 0,
        voice_strength: typeof voice_strength === 'number' ? voice_strength : 0.75,
        output_bundle: Array.isArray(output_bundle) && output_bundle.length
          ? output_bundle
          : ['mp3', 'stems', 'lyrics', 'midi'],
        user_id: user_id || _userId || null
      };

      const data = await hermes.createCover(payload);
      return JSON.stringify({
        ok: true,
        job_id: data.job_id,
        status: data.status || 'queued',
        eta_seconds: data.eta_seconds || null,
        message: data.message || 'Job berhasil di-queue. Poll hermes_status setiap ~10 detik.'
      }, null, 2);
    } catch (e) {
      return `Error hermes_cover: ${e.message}`;
    }
  },

  hermes_status: async (args) => {
    try {
      if (!hermes.isConfigured()) return hermes.configError();
      const { job_id, _onMedia } = args;
      if (!job_id) return "Error: parameter 'job_id' wajib.";

      const data = await hermes.getJobStatus(job_id);
      const summary = {
        job_id,
        status: data.status,
        progress: data.progress != null ? data.progress : null,
        stage: data.stage || null,
        message: data.message || null,
        eta_seconds: data.eta_seconds != null ? data.eta_seconds : null,
        elapsed_seconds: data.elapsed_seconds != null ? data.elapsed_seconds : null
      };

      // Saat done, push artifacts ke Telegram via _onMedia
      if (data.status === 'done' && Array.isArray(data.artifacts) && _onMedia) {
        for (const art of data.artifacts) {
          try {
            const fetched = await hermes.fetchArtifact(job_id, art.filename);
            await _onMedia({
              type: art.media_type || 'document',
              filename: fetched.filename,
              mime_type: fetched.contentType,
              caption: art.caption || `${art.kind || 'artifact'} — job ${job_id}`,
              buffer: fetched.buffer
            });
          } catch (artErr) {
            summary.media_delivery_errors = summary.media_delivery_errors || [];
            summary.media_delivery_errors.push({ filename: art.filename, error: artErr.message });
          }
        }
        summary.artifacts_delivered = data.artifacts.length;
      } else if (Array.isArray(data.artifacts)) {
        summary.artifacts = data.artifacts.map(a => ({
          kind: a.kind,
          filename: a.filename,
          size_bytes: a.size_bytes || null
        }));
      }

      return JSON.stringify(summary, null, 2);
    } catch (e) {
      return `Error hermes_status: ${e.message}`;
    }
  },

  hermes_list_jobs: async (args) => {
    try {
      if (!hermes.isConfigured()) return hermes.configError();
      const { limit = 10, user_id, _userId } = args;
      const data = await hermes.listJobs({ userId: user_id || _userId, limit });
      return JSON.stringify(data, null, 2);
    } catch (e) {
      return `Error hermes_list_jobs: ${e.message}`;
    }
  },

  hermes_cancel_job: async (args) => {
    try {
      if (!hermes.isConfigured()) return hermes.configError();
      const { job_id } = args;
      if (!job_id) return "Error: parameter 'job_id' wajib.";
      const data = await hermes.cancelJob(job_id);
      return JSON.stringify(data, null, 2);
    } catch (e) {
      return `Error hermes_cancel_job: ${e.message}`;
    }
  },

  hermes_upload_voice: async (args) => {
    try {
      if (!hermes.isConfigured()) return hermes.configError();
      const { name, model_url, index_url, language_hint, description } = args;
      if (!name || !model_url) return "Error: parameter 'name' dan 'model_url' wajib.";
      const data = await hermes.uploadVoice({ name, model_url, index_url, language_hint, description });
      return JSON.stringify(data, null, 2);
    } catch (e) {
      return `Error hermes_upload_voice: ${e.message}`;
    }
  }
};

module.exports = tools;
module.exports.WORKSPACE_ROOT = WORKSPACE_ROOT;
module.exports.resolveCwd = resolveCwd;
module.exports.resolvePath = resolvePath;
