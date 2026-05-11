# Hermes — AWS GPU Worker Deployment Guide

This guide walks you through deploying the **`hermes`** worker on an AWS
GPU instance and wiring it to the Telegram bot running on Railway.

The bot itself runs on Railway as before. The worker is a separate Python
service on a GPU box that the bot calls over HTTPS.

> **TL;DR.** Launch a `g4dn.xlarge` (T4, 16 GB VRAM) running Ubuntu 22.04
> with NVIDIA drivers, run `sudo bash worker/install.sh`, fill in
> `/etc/hermes/hermes.env` + `/etc/caddy/Caddyfile`, start the service,
> then set `HERMES_WORKER_URL` + `HERMES_WORKER_TOKEN` on the Railway bot.

## 1. Provision the EC2 instance

| Item                  | Value                                                   |
| --------------------- | ------------------------------------------------------- |
| Instance type         | `g4dn.xlarge` (cheapest workable) or `g5.xlarge`        |
| AMI                   | "Deep Learning AMI GPU PyTorch — Ubuntu 22.04" *or*     |
|                       | plain "Ubuntu 22.04 LTS" (the install script handles    |
|                       | drivers / CUDA, but the DLAMI is faster to bring up)    |
| Storage               | 100 GB gp3 (for model weights + job artifacts)          |
| Security group        | Inbound 22/tcp from your IP, 80/tcp + 443/tcp from 0/0  |
| Elastic IP            | Recommended (so your DNS doesn't break on restart)      |

After the instance is up:

```bash
ssh ubuntu@YOUR_INSTANCE_IP
nvidia-smi   # confirm GPU is visible
```

If `nvidia-smi` is missing, run `sudo ubuntu-drivers autoinstall` and
reboot once before continuing.

## 2. Clone the repo & run the installer

```bash
sudo apt-get install -y git
git clone https://github.com/sirwhy/cpamc-railway.git
cd cpamc-railway
sudo bash worker/install.sh
```

The script:

- installs system packages (Python 3.11, ffmpeg, libsndfile, sox)
- creates the `hermes` system user and `/var/lib/hermes` data dir
- creates a Python venv at `/opt/hermes/venv` with all ML libraries
  (PyTorch CU121, demucs, faster-whisper, basic-pitch, Coqui TTS, rvc-python)
- installs the `hermes-worker.service` systemd unit
- installs Caddy (auto-HTTPS reverse proxy)

> Expect 10–15 minutes the first run — heavy wheels (torch, TTS, demucs)
> are bulky.

## 3. Configure the worker

### 3a. Worker environment

```bash
sudo vim /etc/hermes/hermes.env
```

Required fields:

```ini
# Generate with:  openssl rand -hex 32
HERMES_AUTH_TOKEN=PASTE_LONG_RANDOM_STRING_HERE

# OpenAI-compatible chat API used for translation.
OPENAI_API_KEY=sk-...
# (If you use Together / Groq / Anthropic-compat instead, also set:)
# OPENAI_BASE_URL=https://api.together.xyz/v1
# HERMES_TRANSLATE_MODEL=meta-llama/Llama-3.3-70B-Instruct-Turbo

# Storage — leave default unless you mounted an extra disk somewhere else.
HERMES_DATA_DIR=/var/lib/hermes
```

### 3b. Domain + TLS

Point a DNS A record at the instance's public/elastic IP, e.g.
`hermes.your-domain.com → 18.x.x.x`. Then:

```bash
sudo vim /etc/caddy/Caddyfile
# Replace `hermes.example.com` with `hermes.your-domain.com`
sudo systemctl reload caddy
```

Caddy will obtain a Let's Encrypt cert automatically.

### 3c. Start the worker

```bash
sudo systemctl start hermes-worker
sudo systemctl status hermes-worker --no-pager
```

Smoke-test:

```bash
curl -fsS https://hermes.your-domain.com/healthz
# expect:
# {"ok": true, "version": "0.1.0", "config": {...}}
```

If `/healthz` returns 503, the auth token is missing. Re-edit
`/etc/hermes/hermes.env` and `sudo systemctl restart hermes-worker`.

## 4. Wire the bot on Railway

In the Railway dashboard for your bot service, add:

| Variable               | Value                                                          |
| ---------------------- | -------------------------------------------------------------- |
| `HERMES_WORKER_URL`    | `https://hermes.your-domain.com`                               |
| `HERMES_WORKER_TOKEN`  | the exact `HERMES_AUTH_TOKEN` value you generated in step 3a   |
| `HERMES_TIMEOUT_MS`    | `30000` (default; raise to `60000` if the worker is far away)  |

Redeploy the Railway service. Open Telegram and ping the bot:

```
/start hermes
```

The bot should now respond with the hermes persona prompt and accept
cover requests.

## 5. (Optional) Register RVC voices

Drop pre-trained voice models onto the worker. Two options:

### Option A — POST via the bot

In Telegram:

```
@your_bot hermes — daftarkan voice 'msshadows' dari
https://example.com/msshadows.pth
dan index https://example.com/msshadows.index
```

The bot calls `POST /v1/voices` for you.

### Option B — drop files on disk

```bash
sudo install -d -o hermes -g hermes /var/lib/hermes/voices/msshadows
sudo wget -O /var/lib/hermes/voices/msshadows/model.pth   https://...
sudo wget -O /var/lib/hermes/voices/msshadows/feature.index https://...
sudo chown -R hermes:hermes /var/lib/hermes/voices/msshadows
sudo systemctl restart hermes-worker   # triggers auto-scan
```

Verify in Telegram: ask the bot "daftar voice yang tersedia".

## 6. Try your first cover

In Telegram:

```
@your_bot tolong cover lagu https://youtu.be/dQw4w9WgXcQ versi
Bahasa Indonesia, pertahankan suara penyanyi aslinya, kasih juga stems dan MIDI.
```

The bot will:

1. Confirm parameters and call `hermes_cover` with
   `mode: translation_cover, target_language: id, voice_target: preserve_original`.
2. Poll `hermes_status` every ~10s and stream progress updates to chat.
3. When the job finishes, push the final MP3, stems zip, MIDI, and lyrics
   as separate Telegram attachments.

Expected runtime for a 3:30 song on g4dn.xlarge:
~3-5 minutes (Demucs ~30s, Whisper ~20s, XTTS ~60s, RVC ~30s, mix ~10s,
the rest is I/O + downloads + caching).

## 7. Cost & operations

- `g4dn.xlarge` is $0.526/hr on-demand. **24/7 ≈ $380/mo.** Consider:
  - **Reserved Instances** (1-year, ~40% off) if you'll run continuously.
  - **Stopping the instance when idle.** A simple cron that runs
    `aws ec2 stop-instances` after N minutes of no jobs cuts cost ~90%.
  - **Spot Instances** (~70% off) — fine if you tolerate occasional
    restarts (the worker persists job state to `/var/lib/hermes/jobs/`).
- Disk grows with job artifacts. The worker auto-deletes jobs older than
  `HERMES_JOB_TTL_HOURS` (default 24h) — watch `df -h /var/lib/hermes`.

## 8. Updating the worker

```bash
cd ~/cpamc-railway
git pull
sudo bash worker/install.sh      # idempotent; re-syncs app/ + venv
sudo systemctl restart hermes-worker
```

## 9. Logs & debugging

```bash
sudo journalctl -u hermes-worker -f --no-pager
sudo tail -F /var/log/caddy/hermes.access.log
```

Per-job artifacts live at `/var/lib/hermes/jobs/<job_id>/`:

```
jobs/abc123/
├── state.json          # serialized job state
├── source/source.wav   # downloaded source
├── stems/htdemucs_ft/source/{vocals,drums,bass,other,no_vocals}.wav
├── transcript/{lyrics.txt,lyrics.srt,transcript.json}
├── transcript/lyrics.id.txt        # translated
├── melody/source_basic_pitch.mid
├── synth/{seg_*.wav,manifest.json}
├── voice/{candidate.wav,new_vocal.wav}
└── output/{final.mp3,stems.zip,vocals.wav,...}
```

## 10. Known v1 limitations

See `worker/README.md` — short version:

- **Translation cover quality** is "spoken with pitch", not true singing.
- **`preserve_original` in `translation_cover`** mode currently keeps the
  XTTS output as-is. Workaround: train an RVC of the singer and pass
  `voice_target: "<name>"` explicitly.
- **Concurrent jobs**: 1 by default. The pipeline is GPU-bound.

Track the v2 roadmap in [`worker/README.md`](../worker/README.md).
