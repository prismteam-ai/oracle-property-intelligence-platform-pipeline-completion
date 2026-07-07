"""Expose the Oracle agent as an A2A endpoint.

Run: uv run uvicorn a2a_server:app --port 8788
External agents then interact via the A2A protocol (agent card at
/.well-known/agent-card.json).
"""

from google.adk.a2a.utils.agent_to_a2a import to_a2a

from oracle_agent.agent import root_agent

app = to_a2a(root_agent, port=8788)
