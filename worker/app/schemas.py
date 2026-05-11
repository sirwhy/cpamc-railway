"""Pydantic request / response models for Hermes Worker."""
from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field

Mode = Literal["ai_cover", "translation_cover", "stems_only", "transcribe_only"]
JobStatus = Literal[
    "queued",
    "downloading",
    "separating",
    "transcribing",
    "translating",
    "extracting_melody",
    "synthesizing",
    "voice_converting",
    "mixing",
    "done",
    "failed",
    "cancelled",
]
BundleItem = Literal["mp3", "stems", "lyrics", "midi"]
MediaType = Literal["audio", "voice", "document"]


class CoverRequest(BaseModel):
    source_url: Optional[str] = None
    source_file_id: Optional[str] = None
    mode: Mode
    target_language: Optional[str] = None
    voice_target: str = "preserve_original"
    voice_pitch_shift: int = 0
    voice_strength: float = Field(default=0.75, ge=0.0, le=1.0)
    output_bundle: List[BundleItem] = Field(default_factory=lambda: ["mp3", "stems", "lyrics", "midi"])
    user_id: Optional[str] = None


class CoverResponse(BaseModel):
    job_id: str
    status: JobStatus
    eta_seconds: Optional[int] = None
    message: Optional[str] = None


class Artifact(BaseModel):
    kind: str  # e.g. "final_mp3", "vocal_stem", "lyrics_srt", "melody_midi", "stems_zip"
    filename: str
    media_type: MediaType = "document"
    caption: Optional[str] = None
    size_bytes: Optional[int] = None


class JobStatusResponse(BaseModel):
    job_id: str
    status: JobStatus
    stage: Optional[str] = None
    progress: Optional[float] = None  # 0.0 - 1.0
    message: Optional[str] = None
    eta_seconds: Optional[int] = None
    elapsed_seconds: Optional[int] = None
    artifacts: Optional[List[Artifact]] = None
    request: Optional[CoverRequest] = None


class VoiceModel(BaseModel):
    name: str
    description: Optional[str] = None
    language_hint: Optional[str] = None
    model_path: Optional[str] = None
    index_path: Optional[str] = None
    created_at: Optional[str] = None


class VoiceRegisterRequest(BaseModel):
    name: str
    model_url: str
    index_url: Optional[str] = None
    language_hint: Optional[str] = None
    description: Optional[str] = None


class VoicesResponse(BaseModel):
    voices: List[VoiceModel]


class HealthResponse(BaseModel):
    ok: bool = True
    version: str
    config: dict


class JobsListResponse(BaseModel):
    jobs: List[JobStatusResponse]
