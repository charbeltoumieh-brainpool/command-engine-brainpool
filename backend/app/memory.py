from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import datetime, timezone
import hashlib
import json
import time
from typing import Any

import httpx
import numpy as np

from .config import (
    MODEL_EMBEDDING,
    MODEL_FAST,
    MODEL_ORCHESTRATOR,
    MODEL_WORKER,
    WORKER_REASONING_EFFORT,
    GatewayCredentials,
    load_gateway_credentials,
    read_secret,
)
from .db import db_session, get_settings_dict, record_llm_usage, row_to_dict, utc_now_iso
from .profiles import OWNER_PROFILE_ID, get_active_profile


_MODEL_RATE_TABLE_PER_1M: list[tuple[tuple[str, ...], tuple[float, float]]] = [
    (("gpt-4o-mini", "gpt-4.1-mini"), (0.15, 0.60)),
    (("gpt-4o", "gpt-4.1"), (2.0, 8.0)),
    (("text-embedding", "embedding"), (0.02, 0.0)),
    (("gemini-2.5-pro", "gemini-pro"), (1.25, 10.0)),
    (("gemini-2.5-flash", "flash"), (0.15, 0.60)),
    (("deepseek",), (0.28, 0.42)),
    (("kimi",), (0.60, 2.50)),
]


def estimate_llm_cost_usd(
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    *,
    response_cost: float | None = None,
) -> float:
    if response_cost is not None:
        try:
            val = float(response_cost)
            if val >= 0.0:
                return round(val, 6)
        except (TypeError, ValueError):
            pass

    low = (model or "").strip().lower()
    in_rate, out_rate = (0.50, 1.50)
    for needles, rates in _MODEL_RATE_TABLE_PER_1M:
        if any(n in low for n in needles):
            in_rate, out_rate = rates
            break

    p_tok = max(0, int(prompt_tokens or 0))
    c_tok = max(0, int(completion_tokens or 0))
    cost = (p_tok / 1_000_000.0) * in_rate + (c_tok / 1_000_000.0) * out_rate
    return round(cost, 6)


def _extract_response_cost(headers: Any, data: dict[str, Any] | None = None) -> float | None:
    if headers is not None:
        try:
            hdr_val = headers.get("x-response-cost")
            if hdr_val is not None and str(hdr_val).strip() != "":
                parsed = float(hdr_val)
                if parsed >= 0.0:
                    return parsed
        except (TypeError, ValueError):
            pass
    if isinstance(data, dict):
        usage = data.get("usage")
        candidates = []
        if isinstance(usage, dict):
            candidates.append(usage.get("cost"))
        candidates.append(data.get("cost"))
        for cand in candidates:
            if cand is not None and str(cand).strip() != "":
                try:
                    parsed = float(cand)
                    if parsed >= 0.0:
                        return parsed
                except (TypeError, ValueError):
                    pass
    return None


def check_daily_budget_state(
    profile_id: str,
    daily_budget_usd: float,
    conn: Any | None = None,
) -> dict[str, Any]:
    budget = float(daily_budget_usd or 0.0)
    today_prefix = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    def _query(c: Any) -> Any:
        return c.execute(
            """
            SELECT COALESCE(SUM(cost_usd), 0.0) AS spend_usd,
                   COALESCE(SUM(total_tokens), 0) AS total_tokens,
                   COUNT(*) AS calls
            FROM llm_usage
            WHERE profile_id = ? AND created_at >= ?
            """,
            (profile_id, today_prefix),
        ).fetchone()

    row = _query(conn) if conn is not None else None
    if conn is None:
        with db_session() as _conn:
            row = _query(_conn)

    spend = float(row["spend_usd"] or 0.0) if row else 0.0
    total_tokens = int(row["total_tokens"] or 0) if row else 0
    calls = int(row["calls"] or 0) if row else 0
    exceeded = budget > 0.0 and spend >= budget
    return {
        "profile_id": profile_id,
        "daily_budget_usd": round(budget, 4),
        "spend_today_usd": round(spend, 6),
        "total_tokens_today": total_tokens,
        "calls_today": calls,
        "exceeded": exceeded,
        "remaining_usd": round(max(0.0, budget - spend), 6),
    }


def _is_local_loopback_url(url: str) -> bool:
    low = (url or "").strip().lower()
    return low.startswith("http://127.0.0.1") or low.startswith("http://localhost")


def _supports_reasoning_effort(base_url: str, model: str) -> bool:
    _ = base_url
    low_model = (model or "").lower()
    return low_model.startswith(("o1", "o3", "o4", "gpt-5"))


def resolve_active_llm_runtime(conn: Any | None = None) -> dict[str, Any]:
    """
    Resolve the active profile's LLM gateway, secret, offline local runner, and model roster.
    """
    prof: dict[str, Any] = {}
    settings: dict[str, Any] = {}
    try:
        if conn is not None:
            prof = get_active_profile(conn)
            settings = get_settings_dict(conn)
        else:
            with db_session() as _conn:
                prof = get_active_profile(_conn)
                settings = get_settings_dict(_conn)
    except Exception:
        prof = {}
        settings = {}

    profile_id = str(prof.get("id") or OWNER_PROFILE_ID)
    gateway_locked = bool(prof.get("gateway_locked", False))
    offline_enabled = bool(prof.get("offline_local_runner_enabled", False))
    offline_url = str(prof.get("offline_local_runner_url") or "http://127.0.0.1:11434/v1").strip().rstrip("/")
    offline_model = str(prof.get("offline_local_model") or "").strip()
    custom_base_url = str(prof.get("gateway_base_url") or "").strip().rstrip("/")
    active_provider_id = str(settings.get(f"ai_active_provider:{profile_id}") or "").strip()

    model_orch = str(prof.get("model_orchestrator") or MODEL_ORCHESTRATOR).strip() or MODEL_ORCHESTRATOR
    model_wrk = str(prof.get("model_worker") or MODEL_WORKER).strip() or MODEL_WORKER
    model_fast = str(prof.get("model_fast") or MODEL_FAST).strip() or MODEL_FAST
    model_emb = str(prof.get("model_embedding") or MODEL_EMBEDDING).strip() or MODEL_EMBEDDING
    daily_budget_usd = float(prof.get("daily_budget_usd") if prof.get("daily_budget_usd") is not None else 15.0)

    if offline_enabled and offline_url:
        local_key = read_secret(f"ai-{profile_id}-ollama") or "ollama"
        creds = GatewayCredentials(base_url=offline_url, api_key=local_key, configured=True)
        return {
            "profile_id": profile_id,
            "provider_id": "ollama",
            "gateway_locked": gateway_locked,
            "offline_enabled": True,
            "creds": creds,
            "model_orchestrator": offline_model or model_orch,
            "model_worker": offline_model or model_wrk,
            "model_fast": offline_model or model_fast,
            "model_embedding": model_emb,
            "daily_budget_usd": daily_budget_usd,
        }

    if profile_id == OWNER_PROFILE_ID or gateway_locked:
        provider_id = active_provider_id or "openai-gateway"
        stored_key = read_secret(f"ai-{profile_id}-{provider_id}") or read_secret(f"ai-{profile_id}-openai-gateway")
        fallback_creds = load_gateway_credentials(base_url_override=custom_base_url or None)
        if stored_key:
            base_url = custom_base_url or fallback_creds.base_url
            creds = GatewayCredentials(base_url=base_url, api_key=stored_key, configured=bool(base_url))
        else:
            creds = fallback_creds
        return {
            "profile_id": profile_id,
            "provider_id": provider_id,
            "gateway_locked": gateway_locked,
            "offline_enabled": False,
            "creds": creds,
            "model_orchestrator": model_orch,
            "model_worker": model_wrk,
            "model_fast": model_fast,
            "model_embedding": model_emb,
            "daily_budget_usd": daily_budget_usd,
        }

    provider_id = active_provider_id or ("custom-gateway" if custom_base_url else "")
    stored_key = ""
    if provider_id:
        stored_key = read_secret(f"ai-{profile_id}-{provider_id}")
    if not stored_key and custom_base_url:
        stored_key = read_secret(f"ai-{profile_id}-custom-gateway")

    if custom_base_url and stored_key:
        creds = GatewayCredentials(base_url=custom_base_url, api_key=stored_key, configured=True)
    elif custom_base_url and _is_local_loopback_url(custom_base_url):
        creds = GatewayCredentials(base_url=custom_base_url, api_key=stored_key or "local", configured=True)
    else:
        creds = GatewayCredentials(base_url=custom_base_url, api_key="", configured=False)

    return {
        "profile_id": profile_id,
        "provider_id": provider_id,
        "gateway_locked": False,
        "offline_enabled": False,
        "creds": creds,
        "model_orchestrator": model_orch,
        "model_worker": model_wrk,
        "model_fast": model_fast,
        "model_embedding": model_emb,
        "daily_budget_usd": daily_budget_usd,
    }


def _build_provider_headers(base_url: str, api_key: str) -> dict[str, str]:
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if "api.anthropic.com" in (base_url or "").lower() and api_key:
        headers["x-api-key"] = api_key
        headers["anthropic-version"] = "2023-06-01"
    return headers


class GatewayLLMClient:
    """Profile-aware OpenAI-compatible gateway client with SSE streaming support."""

    def __init__(self) -> None:
        rt = resolve_active_llm_runtime()
        self._runtime = rt
        self._creds = rt["creds"]

    def _refresh_runtime(self) -> dict[str, Any]:
        rt = resolve_active_llm_runtime()
        self._runtime = rt
        self._creds = rt["creds"]
        return rt

    @property
    def headers(self) -> dict[str, str]:
        return _build_provider_headers(self._creds.base_url, self._creds.api_key)

    @staticmethod
    def _apply_budget_throttle(
        rt: dict[str, Any],
        requested_model: str,
        requested_effort: str | None,
    ) -> tuple[str, str | None, bool]:
        if rt.get("offline_enabled"):
            return requested_model, requested_effort, False
        orch = str(rt.get("model_orchestrator") or "")
        fast = str(rt.get("model_fast") or "")
        if requested_model == orch and fast and fast != requested_model:
            try:
                budget_state = check_daily_budget_state(
                    str(rt.get("profile_id") or OWNER_PROFILE_ID),
                    float(rt.get("daily_budget_usd") or 15.0),
                )
                if budget_state.get("exceeded"):
                    return fast, "low", True
            except Exception:
                pass
        return requested_model, requested_effort, False

    @staticmethod
    def _safe_record_usage(
        *,
        profile_id: str,
        provider_id: str,
        model: str,
        operation: str,
        prompt_tokens: int,
        completion_tokens: int,
        total_tokens: int,
        cost_usd: float,
        budget_throttled: bool,
    ) -> None:
        try:
            with db_session() as conn:
                record_llm_usage(
                    conn,
                    profile_id=profile_id,
                    provider_id=provider_id,
                    model=model,
                    operation=operation,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    total_tokens=total_tokens,
                    cost_usd=cost_usd,
                    budget_throttled=budget_throttled,
                )
        except Exception:
            pass

    async def chat(
        self,
        messages: list[dict[str, str]],
        *,
        model: str | None = None,
        reasoning_effort: str | None = "high",
        temperature: float = 0.2,
        json_mode: bool = False,
        timeout: float = 240.0,
    ) -> str:
        rt = self._refresh_runtime()
        creds: GatewayCredentials = rt["creds"]
        if not creds.configured or not creds.base_url:
            raise RuntimeError("Active AI provider is not configured. Set OPENAI_API_KEY in backend/.env.")
        base_model = model or rt["model_orchestrator"]
        resolved_model, resolved_effort, budget_throttled = self._apply_budget_throttle(
            rt, base_model, reasoning_effort
        )
        payload: dict[str, Any] = {
            "model": resolved_model,
            "messages": messages,
            "temperature": temperature,
        }
        if resolved_effort and _supports_reasoning_effort(creds.base_url, resolved_model):
            payload["reasoning_effort"] = resolved_effort
        if json_mode:
            payload["response_format"] = {"type": "json_object"}

        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{creds.base_url}/chat/completions",
                headers=_build_provider_headers(creds.base_url, creds.api_key),
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
            content = str(data["choices"][0]["message"].get("content") or "").strip()

            usage = data.get("usage") if isinstance(data, dict) else {}
            if not isinstance(usage, dict):
                usage = {}
            p_tok = int(usage.get("prompt_tokens") or 0)
            c_tok = int(usage.get("completion_tokens") or 0)
            if p_tok == 0 and c_tok == 0 and (messages or content):
                p_tok = max(1, sum(len(str(m.get("content") or "")) for m in messages) // 4)
                c_tok = max(1, len(content) // 4) if content else 0
            t_tok = int(usage.get("total_tokens") or (p_tok + c_tok))
            resp_cost = _extract_response_cost(getattr(resp, "headers", None), data)
            cost_usd = 0.0 if (rt.get("offline_enabled") and resp_cost is None) else estimate_llm_cost_usd(
                resolved_model, p_tok, c_tok, response_cost=resp_cost
            )
            self._safe_record_usage(
                profile_id=str(rt.get("profile_id") or OWNER_PROFILE_ID),
                provider_id=str(rt.get("provider_id") or ""),
                model=resolved_model,
                operation="chat",
                prompt_tokens=p_tok,
                completion_tokens=c_tok,
                total_tokens=t_tok,
                cost_usd=cost_usd,
                budget_throttled=budget_throttled,
            )
            return content

    async def chat_stream(
        self,
        messages: list[dict[str, str]],
        *,
        model: str | None = None,
        reasoning_effort: str | None = "medium",
        temperature: float = 0.2,
        timeout: float = 240.0,
    ) -> AsyncIterator[str]:
        rt = self._refresh_runtime()
        creds: GatewayCredentials = rt["creds"]
        if not creds.configured or not creds.base_url:
            raise RuntimeError("Active AI provider is not configured. Set OPENAI_API_KEY in backend/.env.")
        base_model = model or rt["model_orchestrator"]
        resolved_model, resolved_effort, budget_throttled = self._apply_budget_throttle(
            rt, base_model, reasoning_effort
        )
        payload: dict[str, Any] = {
            "model": resolved_model,
            "messages": messages,
            "temperature": temperature,
            "stream": True,
        }
        if resolved_effort and _supports_reasoning_effort(creds.base_url, resolved_model):
            payload["reasoning_effort"] = resolved_effort

        stream_usage: dict[str, Any] | None = None
        streamed_chars = 0
        resp_cost: float | None = None
        recorded = False

        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream(
                "POST",
                f"{creds.base_url}/chat/completions",
                headers=_build_provider_headers(creds.base_url, creds.api_key),
                json=payload,
            ) as resp:
                resp.raise_for_status()
                resp_cost = _extract_response_cost(getattr(resp, "headers", None), None)
                try:
                    async for line in resp.aiter_lines():
                        raw_line = (line or "").strip()
                        if not raw_line or not raw_line.startswith("data:"):
                            continue
                        data_str = raw_line[5:].strip()
                        if data_str == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data_str)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(chunk, dict) and isinstance(chunk.get("usage"), dict):
                            stream_usage = chunk["usage"]
                        choices = chunk.get("choices") or []
                        if not choices:
                            continue
                        delta_obj = choices[0].get("delta") or {}
                        token = delta_obj.get("content")
                        if token is None:
                            token = choices[0].get("text")
                        if token:
                            tok_str = str(token)
                            streamed_chars += len(tok_str)
                            yield tok_str
                finally:
                    if not recorded:
                        recorded = True
                        u = stream_usage or {}
                        p_tok = int(u.get("prompt_tokens") or 0)
                        c_tok = int(u.get("completion_tokens") or 0)
                        if p_tok == 0 and c_tok == 0:
                            p_tok = max(1, sum(len(str(m.get("content") or "")) for m in messages) // 4)
                            c_tok = max(1, streamed_chars // 4) if streamed_chars else 0
                        t_tok = int(u.get("total_tokens") or (p_tok + c_tok))
                        chunk_cost = _extract_response_cost(None, {"usage": u}) if u else None
                        eff_cost = resp_cost if resp_cost is not None else chunk_cost
                        cost_usd = 0.0 if (rt.get("offline_enabled") and eff_cost is None) else estimate_llm_cost_usd(
                            resolved_model, p_tok, c_tok, response_cost=eff_cost
                        )
                        self._safe_record_usage(
                            profile_id=str(rt.get("profile_id") or OWNER_PROFILE_ID),
                            provider_id=str(rt.get("provider_id") or ""),
                            model=resolved_model,
                            operation="chat_stream",
                            prompt_tokens=p_tok,
                            completion_tokens=c_tok,
                            total_tokens=t_tok,
                            cost_usd=cost_usd,
                            budget_throttled=budget_throttled,
                        )

    async def chief_of_staff_synthesize(
        self,
        system_prompt: str,
        user_prompt: str,
        json_mode: bool = False,
        reasoning_effort: str | None = "medium",
        model: str | None = None,
    ) -> str:
        rt = self._refresh_runtime()
        return await self.chat(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            model=model or rt["model_orchestrator"],
            reasoning_effort=reasoning_effort,
            temperature=0.2,
            json_mode=json_mode,
        )

    async def worker_analyze(
        self,
        system_prompt: str,
        user_prompt: str,
        json_mode: bool = False,
        model: str | None = None,
    ) -> str:
        rt = self._refresh_runtime()
        return await self.chat(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            model=model or rt["model_worker"],
            reasoning_effort=WORKER_REASONING_EFFORT,
            temperature=0.1,
            json_mode=json_mode,
        )

    async def embed_texts(self, texts: list[str], timeout: float = 60.0) -> list[np.ndarray]:
        if not texts:
            return []
        rt = self._refresh_runtime()
        creds: GatewayCredentials = rt["creds"]
        if not creds.configured or not creds.base_url:
            raise RuntimeError("Active AI provider is not configured. Set OPENAI_API_KEY in backend/.env.")
        emb_model = rt["model_embedding"] or MODEL_EMBEDDING
        cleaned = [t[:8000] if t else " " for t in texts]
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{creds.base_url}/embeddings",
                headers=_build_provider_headers(creds.base_url, creds.api_key),
                json={"model": emb_model, "input": cleaned},
            )
            resp.raise_for_status()
            data = resp.json()
            vectors: list[np.ndarray] = []
            for item in sorted(data["data"], key=lambda x: x["index"]):
                vec = np.asarray(item["embedding"], dtype=np.float32)
                norm = float(np.linalg.norm(vec))
                if norm > 0:
                    vec = vec / norm
                vectors.append(vec)

            usage = data.get("usage") if isinstance(data, dict) else {}
            if not isinstance(usage, dict):
                usage = {}
            p_tok = int(usage.get("prompt_tokens") or usage.get("total_tokens") or 0)
            if p_tok == 0:
                p_tok = max(1, sum(len(t) for t in cleaned) // 4)
            t_tok = int(usage.get("total_tokens") or p_tok)
            resp_cost = _extract_response_cost(getattr(resp, "headers", None), data)
            cost_usd = 0.0 if (rt.get("offline_enabled") and resp_cost is None) else estimate_llm_cost_usd(
                emb_model, p_tok, 0, response_cost=resp_cost
            )
            self._safe_record_usage(
                profile_id=str(rt.get("profile_id") or OWNER_PROFILE_ID),
                provider_id=str(rt.get("provider_id") or ""),
                model=emb_model,
                operation="embed",
                prompt_tokens=p_tok,
                completion_tokens=0,
                total_tokens=t_tok,
                cost_usd=cost_usd,
                budget_throttled=False,
            )
            return vectors


def _hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest()[:32]


async def index_missing_embeddings(limit: int = 60) -> int:
    """Index un-embedded or updated events and tasks into SQLite using the active embedding model."""
    llm = GatewayLLMClient()
    active_pid = str(llm._runtime.get("profile_id") or OWNER_PROFILE_ID)
    emb_model = str(llm._runtime.get("model_embedding") or MODEL_EMBEDDING)
    candidates: list[tuple[str, int, str, str]] = []

    with db_session() as conn:
        event_rows = conn.execute(
            """
            SELECT e.id, e.source, e.title, e.summary, e.body, e.actor, e.channel_or_repo, emb.text_hash
            FROM events e
            LEFT JOIN embeddings emb
              ON emb.item_kind = 'event' AND emb.item_id = e.id AND emb.profile_id = ?
            WHERE e.profile_id = ?
            ORDER BY e.occurred_at DESC
            LIMIT ?
            """,
            (active_pid, active_pid, limit),
        ).fetchall()
        for r in event_rows:
            doc = f"[{r['source']}] {r['title']} | {r['actor']} | {r['channel_or_repo']}\n{r['summary']}\n{r['body'][:1500]}"
            h = _hash_text(doc)
            if r["text_hash"] != h:
                candidates.append(("event", int(r["id"]), doc, h))

        task_rows = conn.execute(
            """
            SELECT t.id, t.bucket, t.source, t.title, t.description, t.repo, t.counterparty, emb.text_hash
            FROM tasks t
            LEFT JOIN embeddings emb
              ON emb.item_kind = 'task' AND emb.item_id = t.id AND emb.profile_id = ?
            WHERE t.profile_id = ?
            ORDER BY t.updated_at DESC
            LIMIT ?
            """,
            (active_pid, active_pid, limit),
        ).fetchall()
        for r in task_rows:
            doc = f"[task:{r['bucket']}:{r['source']}] {r['title']} | {r['repo']} | {r['counterparty']}\n{r['description'][:1500]}"
            h = _hash_text(doc)
            if r["text_hash"] != h:
                candidates.append(("task", int(r["id"]), doc, h))

    if not candidates:
        return 0

    batch = candidates[:limit]
    vectors = await llm.embed_texts([c[2] for c in batch])
    now = utc_now_iso()
    with db_session() as conn:
        for (kind, item_id, _doc, text_hash), vec in zip(batch, vectors):
            conn.execute(
                """
                INSERT INTO embeddings(item_kind, item_id, profile_id, model, text_hash, dim, vector_blob, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(item_kind, item_id) DO UPDATE SET
                    profile_id=excluded.profile_id,
                    model=excluded.model,
                    text_hash=excluded.text_hash,
                    dim=excluded.dim,
                    vector_blob=excluded.vector_blob,
                    updated_at=excluded.updated_at
                """,
                (kind, item_id, active_pid, emb_model, text_hash, int(vec.shape[0]), vec.tobytes(), now),
            )
    return len(batch)


async def hybrid_search(query: str, limit: int = 20, source_filter: str | None = None) -> list[dict[str, Any]]:
    """Reciprocal Rank Fusion (RRF) over SQLite FTS5 keyword matches + embedding cosine similarity."""
    q = (query or "").strip()
    if not q:
        return []

    rrf_scores: dict[tuple[str, int], float] = {}
    safe_fts = " OR ".join(
        f'"{tok.replace(chr(34), "")}"'
        for tok in q.split()
        if tok.strip()
    )

    with db_session() as conn:
        active_pid_row = conn.execute("SELECT id FROM profiles WHERE is_active = 1 LIMIT 1").fetchone()
        active_pid = str(active_pid_row["id"]) if active_pid_row else OWNER_PROFILE_ID

        if safe_fts:
            try:
                fts_rows = conn.execute(
                    """
                    SELECT events_fts.rowid AS id, bm25(events_fts) AS rank
                    FROM events_fts
                    JOIN events e ON e.id = events_fts.rowid
                    WHERE events_fts MATCH ? AND e.profile_id = ?
                    ORDER BY rank
                    LIMIT 40
                    """,
                    (safe_fts, active_pid),
                ).fetchall()
                for idx, r in enumerate(fts_rows):
                    rrf_scores[("event", int(r["id"]))] = rrf_scores.get(("event", int(r["id"])), 0.0) + 1.0 / (40 + idx)
            except Exception:
                pass

            try:
                vault_rows = conn.execute(
                    """
                    SELECT rowid AS id, bm25(vault_notes_fts) AS rank
                    FROM vault_notes_fts
                    WHERE vault_notes_fts MATCH ? AND profile_id = ?
                    ORDER BY rank
                    LIMIT 25
                    """,
                    (safe_fts, active_pid),
                ).fetchall()
                for idx, r in enumerate(vault_rows):
                    rrf_scores[("vault", int(r["id"]))] = rrf_scores.get(("vault", int(r["id"])), 0.0) + 1.15 / (36 + idx)
            except Exception:
                pass

        like_pat = f"%{q}%"
        task_kw = conn.execute(
            """
            SELECT id FROM tasks
            WHERE profile_id = ?
              AND status != 'dismissed'
              AND (title LIKE ? OR description LIKE ? OR repo LIKE ? OR counterparty LIKE ?)
            LIMIT 30
            """,
            (active_pid, like_pat, like_pat, like_pat, like_pat),
        ).fetchall()
        for idx, r in enumerate(task_kw):
            rrf_scores[("task", int(r["id"]))] = rrf_scores.get(("task", int(r["id"])), 0.0) + 1.0 / (40 + idx)

        emb_rows = conn.execute(
            "SELECT item_kind, item_id, dim, vector_blob FROM embeddings WHERE profile_id = ?",
            (active_pid,),
        ).fetchall()

    semantic_online = False
    if emb_rows:
        try:
            llm = GatewayLLMClient()
            if llm._creds.configured:
                q_vecs = await llm.embed_texts([q], timeout=4.0)
                if q_vecs:
                    semantic_online = True
                    q_vec = q_vecs[0]
                    scored_sem: list[tuple[float, str, int]] = []
                    for r in emb_rows:
                        vec = np.frombuffer(r["vector_blob"], dtype=np.float32)
                        if vec.shape[0] == q_vec.shape[0]:
                            sim = float(np.dot(q_vec, vec))
                            scored_sem.append((sim, str(r["item_kind"]), int(r["item_id"])))
                    scored_sem.sort(reverse=True, key=lambda x: x[0])
                    for idx, (sim, kind, item_id) in enumerate(scored_sem[:40]):
                        if sim > 0.25:
                            rrf_scores[(kind, item_id)] = rrf_scores.get((kind, item_id), 0.0) + (1.2 / (35 + idx)) + (sim * 0.05)
        except Exception:
            semantic_online = False

    search_mode = "hybrid" if semantic_online else "fts5_offline"
    ranked = sorted(rrf_scores.items(), key=lambda kv: kv[1], reverse=True)
    results: list[dict[str, Any]] = []
    with db_session() as conn:
        for (kind, item_id), score in ranked:
            if kind == "event":
                row = conn.execute("SELECT * FROM events WHERE id = ? AND profile_id = ?", (item_id, active_pid)).fetchone()
                if row:
                    d = row_to_dict(row) or {}
                    if source_filter and d.get("source") != source_filter:
                        continue
                    summary_txt = d.get("summary") or d.get("body", "")[:240]
                    results.append(
                        {
                            "kind": "event",
                            "id": item_id,
                            "score": round(score, 4),
                            "search_mode": search_mode,
                            "source": d.get("source"),
                            "title": d.get("title"),
                            "summary": summary_txt,
                            "snippet": summary_txt,
                            "url": d.get("url"),
                            "actor": d.get("actor"),
                            "priority": d.get("priority"),
                            "timestamp": d.get("occurred_at"),
                        }
                    )
            elif kind == "task":
                if source_filter and source_filter not in {"tasks", "task"}:
                    continue
                row = conn.execute("SELECT * FROM tasks WHERE id = ? AND profile_id = ?", (item_id, active_pid)).fetchone()
                if row:
                    d = row_to_dict(row) or {}
                    summary_txt = d.get("description", "")[:240]
                    results.append(
                        {
                            "kind": "task",
                            "id": item_id,
                            "score": round(score, 4),
                            "search_mode": search_mode,
                            "source": f"task:{d.get('bucket')}",
                            "title": d.get("title"),
                            "summary": summary_txt,
                            "snippet": summary_txt,
                            "url": d.get("source_url"),
                            "actor": d.get("counterparty") or d.get("owner"),
                            "priority": d.get("priority"),
                            "timestamp": d.get("updated_at"),
                        }
                    )
            elif kind == "vault":
                if source_filter and source_filter not in {"vault", "wiki", "notes"}:
                    continue
                vrow = conn.execute(
                    "SELECT folder, slug, title, content_md FROM vault_notes_fts WHERE rowid = ? AND profile_id = ?",
                    (item_id, active_pid),
                ).fetchone()
                if vrow:
                    snippet_txt = str(vrow["content_md"] or "").replace("\n", " ").strip()[:240]
                    results.append(
                        {
                            "kind": "vault",
                            "id": item_id,
                            "score": round(score, 4),
                            "search_mode": search_mode,
                            "source": f"vault:{vrow['folder']}",
                            "title": vrow["title"],
                            "summary": snippet_txt,
                            "snippet": snippet_txt,
                            "url": f"vault://{vrow['folder']}/{vrow['slug']}",
                            "actor": "Vault",
                            "priority": "P2",
                            "timestamp": utc_now_iso(),
                        }
                    )
            if len(results) >= limit:
                break
    return results


_GATEWAY_PROBE_CACHE: dict[str, dict[str, Any]] = {}
GATEWAY_CACHE_TTL_SECONDS = 45.0


def invalidate_gateway_cache() -> None:
    """Clear cached gateway connectivity probes."""
    _GATEWAY_PROBE_CACHE.clear()


async def check_gateway_connectivity(force: bool = False) -> dict[str, Any]:
    """Non-blocking 45s cached check for truthful online | degraded | offline status."""
    now = time.monotonic()
    rt = resolve_active_llm_runtime()
    creds: GatewayCredentials = rt["creds"]
    cache_key = f"{rt['profile_id']}|{rt['provider_id']}|{creds.base_url}|{rt['offline_enabled']}"

    if not force:
        cached = _GATEWAY_PROBE_CACHE.get(cache_key)
        if cached and (now - float(cached.get("ts", 0.0))) < GATEWAY_CACHE_TTL_SECONDS:
            return dict(cached)

    if not creds.configured or not creds.base_url:
        res = {
            "ts": now,
            "status": "offline",
            "detail": "Set OPENAI_API_KEY in backend/.env to enable AI model calls.",
        }
        _GATEWAY_PROBE_CACHE[cache_key] = res
        return dict(res)

    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(
                f"{creds.base_url}/models",
                headers=_build_provider_headers(creds.base_url, creds.api_key),
            )
            if resp.status_code < 500:
                res = {
                    "ts": now,
                    "status": "online",
                    "detail": f"Connected ({rt['provider_id'] or creds.base_url})",
                }
            else:
                res = {
                    "ts": now,
                    "status": "degraded",
                    "detail": f"Gateway HTTP {resp.status_code}; local FTS5 fallback active.",
                }
    except Exception:
        res = {
            "ts": now,
            "status": "offline",
            "detail": "Offline — working from local SQLite & FTS5.",
        }

    _GATEWAY_PROBE_CACHE[cache_key] = res
    return dict(res)
