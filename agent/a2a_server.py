"""Expose the Oracle agent as an A2A endpoint.

Run: uv run uvicorn a2a_server:app --port 8788
External agents then interact via the A2A protocol (agent card at
/.well-known/agent-card.json).
"""

from google.adk.a2a.utils.agent_to_a2a import to_a2a
from starlette.middleware.cors import CORSMiddleware

from oracle_agent.agent import root_agent

# to_a2a returns a Starlette app; allow browser clients (the exploration UI
# on :5173) to call the JSON-RPC endpoint cross-origin.
app = to_a2a(root_agent, port=8788)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
