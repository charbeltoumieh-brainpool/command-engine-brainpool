from __future__ import annotations

from .github_collector import collect_github
from .local_collector import collect_local, collect_local_workspace

__all__ = [
    "collect_github",
    "collect_local",
    "collect_local_workspace",
]
