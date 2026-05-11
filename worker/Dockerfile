# Hermes Worker — CUDA 12.1 base for PyTorch wheels.
# Tested on g4dn.xlarge (T4 16GB) and g5.xlarge (A10G 24GB).
# Build:  docker build -t hermes-worker .
# Run:    docker compose up -d  (see docker-compose.yml)

FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/data/cache/huggingface \
    TRANSFORMERS_CACHE=/data/cache/huggingface \
    TORCH_HOME=/data/cache/torch \
    COQUI_TOS_AGREED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv \
        ffmpeg git curl ca-certificates build-essential \
        libsndfile1 libsox-fmt-all sox \
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/bin/python3 /usr/bin/python

WORKDIR /opt/hermes

# Lightweight server deps first for cache efficiency
COPY requirements.txt /opt/hermes/requirements.txt
RUN pip install --upgrade pip setuptools wheel
RUN pip install -r /opt/hermes/requirements.txt

# Heavy ML deps. We pin torch CU121 wheels so the runtime matches the base image.
RUN pip install --index-url https://download.pytorch.org/whl/cu121 \
        torch==2.4.1+cu121 torchaudio==2.4.1+cu121 \
    && pip install \
        faster-whisper==1.0.3 \
        demucs==4.0.1 \
        basic-pitch==0.4.0 \
        TTS==0.22.0 \
        rvc-python==0.1.6

COPY app /opt/hermes/app

VOLUME ["/data"]
EXPOSE 8000

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
