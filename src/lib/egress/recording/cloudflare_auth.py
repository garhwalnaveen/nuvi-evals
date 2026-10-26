"""Restrict Cloudflare credential forwarding to this run's model calls."""

from __future__ import annotations

import json
import re
from pathlib import Path

CREDENTIAL_PATH = Path("/run/eval-credentials/cloudflare.json")


def authorization(method: str, path: str, body: bytes, credential_path: Path = CREDENTIAL_PATH) -> str:
    credentials = json.loads(credential_path.read_text())
    if not isinstance(credentials, dict):
        raise ValueError("Invalid Cloudflare proxy credentials")
    account = credentials.get("accountId")
    token = credentials.get("token")
    models = credentials.get("models")
    if (
        not isinstance(account, str)
        or re.fullmatch(r"[a-f0-9]{32}", account) is None
        or not isinstance(token, str)
        or re.fullmatch(r"\S+", token) is None
        or not isinstance(models, list)
        or not models
        or any(not isinstance(model, str) or not model.startswith("@cf/") for model in models)
    ):
        raise ValueError("Invalid Cloudflare proxy credentials")
    if method != "POST" or path != f"/client/v4/accounts/{account}/ai/v1/chat/completions":
        raise ValueError("Cloudflare route is outside this eval")
    request = json.loads(body)
    if not isinstance(request, dict) or request.get("model") not in models:
        raise ValueError("Cloudflare model is outside this eval")
    return f"Bearer {token}"
