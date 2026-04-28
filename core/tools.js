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
  }
};

module.exports = tools;
module.exports.WORKSPACE_ROOT = WORKSPACE_ROOT;
module.exports.resolveCwd = resolveCwd;
module.exports.resolvePath = resolvePath;
