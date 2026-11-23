# Command Engine

A local-first web command center built with FastAPI, SQLite (FTS5 + vector search), React, Three.js, and Vite.

## Workspaces

- **Orbit** — Interactive 3D command stage and natural-language mission / Q&A bar
- **Approvals** — Human review and sign-off gate for staged outbound actions
- **Work** — Action items (`Needed From Me` and `Waiting On Others`) and priority tracking
- **Missions** — Multi-step agent runs, starter templates, and executive briefings
- **Changes** — Unified activity feed across connected channels and repositories
- **Meetings** — Call notes, transcript processing, prep briefs, and commitment extraction

---

## Quick Start

### 1. Configure Environment

Copy `.env.example` to `.env` in the repository root (or `backend/.env`) and add your credentials:

```powershell
Copy-Item .env.example .env
```

Set `OPENAI_API_KEY` (and optionally `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_EMBEDDING_MODEL`) to enable AI synthesis, briefings, and semantic indexing. External connectors (`GITHUB_TOKEN`, `GITHUB_REPOS`, `SLACK_BOT_TOKEN`, `WORKSPACE_REPOS_DIR`, etc.) are configured via `.env`.

### 2. Start Backend & Web UI (`start-web.ps1`)

Launch FastAPI (`127.0.0.1:8085`) and Vite (`127.0.0.1:5179`) from the repository root:

```powershell
.\start-web.ps1
```

Open **http://127.0.0.1:5179** in your browser.

---

## Manual Startup

### Backend (`127.0.0.1:8085`)

```powershell
uv run --directory backend uvicorn app.main:app --host 127.0.0.1 --port 8085 --reload
```

Or with a standard virtual environment:

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e .
uvicorn app.main:app --host 127.0.0.1 --port 8085 --reload
```

### Frontend (`127.0.0.1:5179`)

```powershell
cd frontend
npm install
npm run dev -- --host 127.0.0.1 --port 5179
```
