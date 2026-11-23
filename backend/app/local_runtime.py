"""Local LLM Runtime Detector (Ollama & LM Studio) + On-Demand Pull Scaffold.

- Probes local loopback ports only (`127.0.0.1:11434` for Ollama first,
  `127.0.0.1:1234` for LM Studio second) with short timeouts.
- Never bundles model weights and never initiates multi-GB model downloads
  automatically; provides an explicit on-demand pull plan/scaffold instead.
"""

from __future__ import annotations

import shutil
from typing import Any

import httpx

OLLAMA_ROOT_URL = "http://127.0.0.1:11434"
OLLAMA_OPENAI_URL = "http://127.0.0.1:11434/v1"
LMSTUDIO_OPENAI_URL = "http://127.0.0.1:1234/v1"

ON_DEMAND_MODEL_CATALOG: list[dict[str, Any]] = [
    {
        "id": "llama3.2:3b",
        "role": "fast_and_chat",
        "label": "Llama 3.2 3B Instruct",
        "approx_size_gb": 2.0,
        "runtime": "ollama",
        "pull_command": "ollama pull llama3.2:3b",
        "description": "Compact everyday local chat, triage, and briefing synthesis.",
    },
    {
        "id": "qwen2.5-coder:7b",
        "role": "orchestrator_and_code",
        "label": "Qwen 2.5 Coder 7B",
        "approx_size_gb": 4.7,
        "runtime": "ollama",
        "pull_command": "ollama pull qwen2.5-coder:7b",
        "description": "Strong local tool-calling and worktree code assistant.",
    },
    {
        "id": "nomic-embed-text",
        "role": "embedding",
        "label": "Nomic Embed Text v1.5",
        "approx_size_gb": 0.27,
        "runtime": "ollama",
        "pull_command": "ollama pull nomic-embed-text",
        "description": "Lightweight local semantic embeddings (hybrid with SQLite FTS5).",
    },
]


def _split_chat_and_embedding_models(models: list[str]) -> tuple[list[str], list[str]]:
    chat: list[str] = []
    emb: list[str] = []
    for m in models:
        low = m.lower()
        if "embed" in low or "bge-" in low or "e5-" in low:
            emb.append(m)
        else:
            chat.append(m)
    return chat, emb


async def probe_ollama(timeout: float = 1.2) -> dict[str, Any]:
    cli_path = shutil.which("ollama")
    models: list[str] = []
    running = False
    error: str | None = None
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(f"{OLLAMA_ROOT_URL}/api/tags")
            if resp.status_code == 200:
                running = True
                data = resp.json()
                for item in data.get("models") or []:
                    name = str(item.get("name") or item.get("model") or "").strip()
                    if name and name not in models:
                        models.append(name)
    except Exception as exc:
        error = str(exc)

    chat_models, emb_models = _split_chat_and_embedding_models(models)
    return {
        "id": "ollama",
        "name": "Ollama",
        "priority": 1,
        "running": running,
        "cli_installed": bool(cli_path),
        "cli_path": cli_path or "",
        "base_url": OLLAMA_OPENAI_URL,
        "models": models,
        "chat_models": chat_models,
        "embedding_models": emb_models,
        "recommended_chat_model": chat_models[0] if chat_models else "llama3.2:3b",
        "recommended_embedding_model": emb_models[0] if emb_models else "",
        "error": None if running else error,
    }


async def probe_lmstudio(timeout: float = 1.2) -> dict[str, Any]:
    models: list[str] = []
    running = False
    error: str | None = None
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(f"{LMSTUDIO_OPENAI_URL}/models")
            if resp.status_code == 200:
                running = True
                data = resp.json()
                for item in data.get("data") or []:
                    mid = str(item.get("id") or "").strip()
                    if mid and mid not in models:
                        models.append(mid)
    except Exception as exc:
        error = str(exc)

    chat_models, emb_models = _split_chat_and_embedding_models(models)
    return {
        "id": "lmstudio",
        "name": "LM Studio",
        "priority": 2,
        "running": running,
        "cli_installed": bool(shutil.which("lms")),
        "cli_path": shutil.which("lms") or "",
        "base_url": LMSTUDIO_OPENAI_URL,
        "models": models,
        "chat_models": chat_models,
        "embedding_models": emb_models,
        "recommended_chat_model": chat_models[0] if chat_models else "local-model",
        "recommended_embedding_model": emb_models[0] if emb_models else "",
        "error": None if running else error,
    }


async def detect_local_runtimes(timeout: float = 1.2) -> dict[str, Any]:
    """Detect local model runtimes (Ollama first, LM Studio second)."""
    ollama_info = await probe_ollama(timeout=timeout)
    lmstudio_info = await probe_lmstudio(timeout=timeout)
    runtimes = [ollama_info, lmstudio_info]

    preferred: dict[str, Any] | None = None
    if ollama_info["running"]:
        preferred = ollama_info
    elif lmstudio_info["running"]:
        preferred = lmstudio_info

    return {
        "any_running": preferred is not None,
        "preferred_runtime": preferred["id"] if preferred else None,
        "preferred_base_url": preferred["base_url"] if preferred else OLLAMA_OPENAI_URL,
        "preferred_model": preferred["recommended_chat_model"] if preferred else "",
        "runtimes": runtimes,
        "on_demand_catalog": ON_DEMAND_MODEL_CATALOG,
        "weights_bundled": False,
    }


def build_on_demand_pull_plan(model_id: str, runtime: str = "ollama") -> dict[str, Any]:
    """Scaffold on-demand model download instructions without downloading weights automatically."""
    clean_model = (model_id or "").strip() or "llama3.2:3b"
    clean_rt = (runtime or "ollama").strip().lower()
    matched = next((m for m in ON_DEMAND_MODEL_CATALOG if m["id"] == clean_model), None)
    cli_available = bool(shutil.which("ollama")) if clean_rt == "ollama" else bool(shutil.which("lms"))
    cmd = f"ollama pull {clean_model}" if clean_rt == "ollama" else f"lms get {clean_model}"
    return {
        "ok": True,
        "status": "scaffold_ready",
        "downloaded": False,
        "runtime": clean_rt,
        "model_id": clean_model,
        "approx_size_gb": matched["approx_size_gb"] if matched else None,
        "cli_available": cli_available,
        "command": cmd,
        "install_url": (
            "https://ollama.com/download" if clean_rt == "ollama" else "https://lmstudio.ai"
        ),
        "note": (
            "Model weights are never bundled in the installer. Run the pull command in your "
            "terminal when ready, then click 'Detect Local Runtime' to connect."
        ),
    }


def build_ai_capability_matrix(runtime_dict: dict[str, Any]) -> dict[str, Any]:
    """Classify which product capabilities run key-free vs local-model vs cloud API key."""
    creds = runtime_dict.get("creds")
    configured = bool(getattr(creds, "configured", False))
    provider_id = str(runtime_dict.get("provider_id") or "").strip().lower()
    is_local = bool(
        runtime_dict.get("offline_enabled")
        or provider_id in {"local", "ollama", "lmstudio"}
    )

    if not configured or provider_id == "none":
        ai_mode = "limited_no_key"
        mode_label = "Limited Mode (No API Key)"
    elif is_local:
        ai_mode = "local"
        mode_label = "Local Model Runtime"
    else:
        ai_mode = "cloud"
        mode_label = "Cloud / API Gateway"

    has_semantic_embeddings = configured and (
        ai_mode == "cloud"
        or bool(str(runtime_dict.get("model_embedding") or "").strip())
    )

    features = {
        "tasks_approvals_orbit": {
            "available": True,
            "tier": "key_free",
            "detail": "Tasks, Approval Studio, Orbit, and durable missions work 100% offline.",
        },
        "vault_and_keyword_search": {
            "available": True,
            "tier": "key_free",
            "detail": "Markdown Vault + SQLite FTS5 keyword search work without any model or key.",
        },
        "deterministic_autopilot": {
            "available": True,
            "tier": "key_free",
            "detail": "Ownership guardrails, safety classification, and worktree staging run deterministically.",
        },
        "live_browser_executor": {
            "available": True,
            "tier": "key_free",
            "detail": "Playwright DOM inspection, deterministic executor, and approval gates work key-free.",
        },
        "voice_tts_briefings": {
            "available": True,
            "tier": "key_free",
            "detail": "Local Pocket-TTS WAV voice synthesis runs without paid API keys.",
        },
        "generative_chat_and_briefings": {
            "available": ai_mode in {"cloud", "local"},
            "degraded_in_limited": True,
            "tier": "local_or_cloud",
            "detail": (
                "Active via configured model."
                if ai_mode in {"cloud", "local"}
                else "Running deterministic FTS5 summaries until a local runtime or API key is connected."
            ),
        },
        "semantic_vector_search": {
            "available": has_semantic_embeddings,
            "tier": "local_or_cloud",
            "detail": (
                "Hybrid vector + FTS5 retrieval active."
                if has_semantic_embeddings
                else "Using SQLite FTS5 keyword search (connect an embedding model for semantic vectors)."
            ),
        },
        "multi_model_council": {
            "available": ai_mode == "cloud",
            "tier": "cloud_required",
            "disabled_reason": (
                None
                if ai_mode == "cloud"
                else "3-Model Strategy Council requires a cloud or multi-model API gateway and is disabled in local/no-key mode."
            ),
            "detail": "Parallel multi-model debate across distinct frontier models.",
        },
    }

    return {
        "ai_mode": ai_mode,
        "mode_label": mode_label,
        "provider_id": provider_id or "none",
        "configured": configured,
        "is_local": is_local,
        "features": features,
    }
