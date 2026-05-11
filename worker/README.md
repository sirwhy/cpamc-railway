# Hermes Worker

GPU-side companion service for the `cpamc-railway` Telegram bot's
**`hermes`** skill (multi-language translation cover + AI cover pipeline).

The bot (Node.js, Railway, CPU) calls this worker (Python / FastAPI / CUDA)
over authenticated HTTPS. The worker does the heavy lifting:

```
              ┌──────────────────────────────────────────────────────┐
   user ⇆ bot │ /v1/cover, /v1/jobs/*/status, /v1/voices, /v1/upload │ ⇆ GPU pipeline
              └──────────────────────────────────────────────────────┘
                              │
                              ▼
   yt-dlp → Demucs → Whisper → translate → basic-pitch → XTTS-v2 → RVC → ffmpeg
```

## Quick start (Docker, recommended for AWS)

```bash
git clone https://github.com/sirwhy/cpamc-railway.git
cd cpamc-railway/worker

cp .env.example .env
# Edit .env — at minimum set HERMES_AUTH_TOKEN and OPENAI_API_KEY
openssl rand -hex 32   # paste into HERMES_AUTH_TOKEN

docker compose up -d
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8000/healthz
```

You will also need NVIDIA Container Toolkit on the host
(`sudo apt-get install nvidia-container-toolkit && sudo systemctl restart docker`).

## Bare-metal install (AWS EC2 GPU instance)

```bash
sudo bash worker/install.sh
sudoedit /etc/hermes/hermes.env       # paste token + API key
sudoedit /etc/caddy/Caddyfile          # set your domain
sudo systemctl reload caddy
sudo systemctl start hermes-worker
curl -fsS https://hermes.your-domain.com/healthz
```

Full step-by-step deploy guide (DNS, firewall, Caddy TLS, Railway env vars,
testing through Telegram): [`docs/hermes-deployment.md`](../docs/hermes-deployment.md).

## API

All endpoints except `/healthz` require `Authorization: Bearer <HERMES_AUTH_TOKEN>`.

### `GET /healthz`
Returns the worker's version and a snapshot of resolved configuration.

### `POST /v1/cover`
Submit a job. Body:

```json
{
  "source_url": "https://www.youtube.com/watch?v=...",
  "source_file_id": "ab12cd34.wav",
  "mode": "translation_cover",
  "target_language": "id",
  "voice_target": "preserve_original",
  "voice_pitch_shift": 0,
  "voice_strength": 0.75,
  "output_bundle": ["mp3", "stems", "lyrics", "midi"],
  "user_id": "tg:12345"
}
```

Supply exactly one of `source_url` / `source_file_id`.

`mode` is one of:

| Mode                | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `ai_cover`          | Same language; swap singer's timbre via RVC.         |
| `translation_cover` | New language; XTTS-v2 sings translated lyrics → RVC. |
| `stems_only`        | Demucs only — return separated stems.                |
| `transcribe_only`   | Whisper only — return lyrics .srt / .txt.            |

`voice_target`:

* `"preserve_original"` — keep the source singer (RVC no-op for `ai_cover`,
   defers to XTTS output for `translation_cover` until a voice is uploaded).
* `<voice_name>` — name of an RVC model registered via `POST /v1/voices`.
* `"generic_synth"` — skip RVC entirely.

### `GET /v1/jobs/{job_id}/status`
Returns current job state. Artifacts are populated incrementally — e.g.
stems appear as soon as Demucs finishes, lyrics as soon as Whisper finishes.

### `GET /v1/jobs/{job_id}/result/{filename}`
Downloads a specific artifact (e.g. `final.mp3`, `stems.zip`, `lyrics.id.srt`,
`melody.mid`, `vocals.wav`).

### `GET /v1/voices` / `POST /v1/voices` / `DELETE /v1/voices/{name}`
RVC voice registry. POST body:

```json
{
  "name": "msshadows",
  "model_url": "https://huggingface.co/.../msshadows.pth",
  "index_url": "https://huggingface.co/.../msshadows.index",
  "language_hint": "en",
  "description": "M. Shadows (A7X) — community-trained RVC v2"
}
```

You can also drop `model.pth` / `feature.index` into
`$HERMES_DATA_DIR/voices/<name>/` and they will be auto-discovered on the
next service restart.

### `POST /v1/upload`
Upload an audio file for use as `source_file_id` in `/v1/cover`. Multipart
form upload, single file field `file`. Returns:

```json
{ "ok": true, "upload_id": "ab12cd34.wav", "size_bytes": 4321567 }
```

## v1 limitations (read this!)

* **Translation cover quality** is "spoken with pitch" rather than "properly
  sung" because XTTS-v2 is a *speech* model. For slow ballads the result is
  pleasant; fast rap/rock cuts will sound robotic. A real singing-voice
  synthesizer (DiffSinger / So-VITS-SVC with per-language phoneme models)
  is planned for v2.
* **`preserve_original` voice in `translation_cover`** mode does not
  auto-train an RVC of the source singer. v1 returns the XTTS output as-is.
  Workaround: train an RVC of the singer separately and register it via
  `POST /v1/voices`, then call with `voice_target: "<name>"`.
* **No real-time progress streaming** — clients poll `/v1/jobs/{id}/status`.
* **Single-node, in-process queue.** Restarting the worker loses any
  *in-flight* job (queued and finished jobs survive on disk).

## Troubleshooting

`/healthz` returns 503: `HERMES_AUTH_TOKEN` not configured. Edit `.env`
(or `/etc/hermes/hermes.env`) and restart.

`yt-dlp: ERROR: Sign in to confirm your age`: set
`YT_DLP_COOKIES=/path/to/cookies.txt` in env (cookies exported from
your browser).

`CUDA out of memory`: lower `HERMES_MAX_CONCURRENT_JOBS=1`, or use a
larger instance, or set `HERMES_WHISPER_MODEL=medium`.

Demucs is slow: the first invocation downloads `htdemucs_ft` weights
(~80 MB). Subsequent runs are cached at `$TORCH_HOME`.

Coqui TTS license prompt blocks startup: `COQUI_TOS_AGREED=1` is already
exported in the Dockerfile — for bare-metal add the same to
`/etc/hermes/hermes.env`.
