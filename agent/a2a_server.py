"""Expose the Oracle agent as an A2A endpoint.

The agent card must advertise the PUBLIC url, not localhost. Render provides
the external URL via RENDER_EXTERNAL_URL; we parse it into the host/protocol/port
that to_a2a() bakes into the card's rpc_url. Falls back to localhost for dev.

Run locally:   uv run uvicorn a2a_server:app --port 8788
Run on Render: uv run uvicorn a2a_server:app --host 0.0.0.0 --port $PORT
"""

import os
from urllib.parse import urlparse

from google.adk.a2a.utils.agent_to_a2a import to_a2a
from starlette.middleware.cors import CORSMiddleware

from oracle_agent.agent import root_agent

_external = os.getenv("RENDER_EXTERNAL_URL") or os.getenv("A2A_PUBLIC_URL")
if _external:
    _u = urlparse(_external)
    _host = _u.hostname or "localhost"
    _protocol = _u.scheme or "https"
    _port = _u.port or (443 if _protocol == "https" else 80)
else:
    _host, _protocol, _port = "localhost", "http", 8788

# allow the exploration UI (a browser client) to call the JSON-RPC endpoint
# cross-origin; the card advertises the public URL above.
app = to_a2a(root_agent, host=_host, port=_port, protocol=_protocol)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
