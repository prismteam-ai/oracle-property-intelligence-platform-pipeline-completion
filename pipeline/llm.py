"""Claude LLM layer for the chat agent.

The Anthropic API key is never stored in the repo: it is read from the
ANTHROPIC_API_KEY env var if set, otherwise fetched from Azure Key Vault
(secret `anthropic-api-key`) using DefaultAzureCredential (az login).
If neither is available the agent falls back to rule-based answers.
"""
import os
import threading

KEY_VAULT_URL = os.environ.get("KEY_VAULT_URL", "https://opi-kv-14929.vault.azure.net/")
SECRET_NAME = os.environ.get("ANTHROPIC_SECRET_NAME", "anthropic-api-key")
MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-5-20250929")

_lock = threading.Lock()
_state = {"key": None, "resolved": False, "client": None}


def _get_key():
    with _lock:
        if _state["resolved"]:
            return _state["key"]
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            try:
                from azure.identity import DefaultAzureCredential
                from azure.keyvault.secrets import SecretClient
                client = SecretClient(vault_url=KEY_VAULT_URL,
                                      credential=DefaultAzureCredential())
                key = client.get_secret(SECRET_NAME).value
            except Exception:
                key = None
        _state["key"] = key
        _state["resolved"] = True
        return key


def _client():
    key = _get_key()
    if not key:
        return None
    with _lock:
        if _state["client"] is None:
            import anthropic
            _state["client"] = anthropic.Anthropic(api_key=key)
        return _state["client"]


def available():
    return _client() is not None


def _ask(system, user, max_tokens=700):
    client = _client()
    if client is None:
        return None
    try:
        resp = client.messages.create(
            model=MODEL, max_tokens=max_tokens, system=system,
            messages=[{"role": "user", "content": user}])
        return "".join(b.text for b in resp.content if b.type == "text").strip()
    except Exception:
        return None


def narrate(question, result):
    """Turn a structured query result into a short conversational answer."""
    rows = result.get("rows") or []
    preview = "\n".join(str(r) for r in rows[:12])
    user = (f"Question: {question}\n"
            f"Result count: {len(rows)}\n"
            f"Columns: {result.get('columns')}\n"
            f"Sample rows:\n{preview}\n"
            f"Methodology/basis: {result.get('basis', '')}")
    return _ask(
        "You are a property-intelligence analyst for Santa Clara County. "
        "Summarize the query result for the user in 2-4 sentences: what was "
        "found, notable examples, and any caveats from the methodology. "
        "Plain text only, no markdown tables.", user, max_tokens=400)


def generate_sql(question, schema):
    """Ask Claude to write a DuckDB SELECT for a question no rule matched."""
    sql = _ask(
        "You write DuckDB SQL. Reply with a single SELECT statement only — "
        "no markdown fences, no commentary. Always include LIMIT 50. "
        "Dates in permits.ISSUEDATE look like '4/10/2018 12:00:00 AM'; parse "
        "with try_strptime(ISSUEDATE, '%-m/%-d/%Y %-I:%M:%S %p'). "
        "String matching should be case-insensitive (ILIKE).",
        f"Schema:\n{schema}\n\nQuestion: {question}", max_tokens=500)
    if not sql:
        return None
    sql = sql.strip().strip("`").removeprefix("sql").strip()
    if not sql.lower().lstrip().startswith(("select", "with")):
        return None
    return sql
