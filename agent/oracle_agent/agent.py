"""Oracle Property Intelligence agent.

The deliverable agent: answers property-intelligence questions against the
Oracle's MCP query layer (DuckDB over IPFS-hosted Parquet), with source-backed
evidence. Exposed two ways: ADK runner (dev/UI) and an A2A endpoint so
external agents can query the Oracle as a peer.

Model: Azure OpenAI GPT-5.4 via LiteLLM.
Tools: the elephant MCP server (queryProperties, getPropertyQuerySchema, ...).
"""

import os
from pathlib import Path

from dotenv import load_dotenv

# Root .env holds the canonical creds (AZURE_OPENAI_*); LiteLLM expects
# AZURE_API_*. Map once at import, never hardcode.
load_dotenv(Path(__file__).resolve().parents[2] / ".env")
os.environ.setdefault("AZURE_API_KEY", os.getenv("AZURE_OPENAI_KEY", ""))
os.environ.setdefault("AZURE_API_BASE", os.getenv("AZURE_OPENAI_ENDPOINT", ""))
os.environ.setdefault("AZURE_API_VERSION", os.getenv("AZURE_OPENAI_API_VERSION", ""))

from google.adk.agents import Agent  # noqa: E402
from google.adk.models.lite_llm import LiteLlm  # noqa: E402
from google.adk.tools import McpToolset  # noqa: E402
from google.adk.tools.mcp_tool.mcp_session_manager import (  # noqa: E402
    StreamableHTTPConnectionParams,
)

MCP_URL = os.getenv("ORACLE_MCP_URL", "http://localhost:8787/mcp")
DEPLOYMENT = os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-5.4")
COUNTY = os.getenv("ORACLE_COUNTY", "lee")

INSTRUCTION = f"""
You are the Oracle Property Intelligence agent. You answer questions about
properties in the county '{COUNTY}' using ONLY the MCP tools available to you.
The data is county public-record data served from IPFS via DuckDB.

Method:
1. If you have not seen the schema this session, call getPropertyQuerySchema
   for county '{COUNTY}' before writing SQL.
2. Answer attribute/filter/count questions with ONE read-only SELECT (or CTE)
   via queryProperties. Permits: queryPermits/getPermitCoverage. Geo questions:
   compute haversine distance in SQL from latitude/longitude.
3. Every answer must be source-backed: cite the county, the source_system
   value, and include property_cid for any specific property you name (it is
   the IPFS content identifier of that property's full provenance record).
4. Be honest about data limits. If the schema cannot answer the question
   (e.g. a field that does not exist), say exactly what is missing and which
   dataset would provide it. Never fabricate values, counts, or CIDs.
5. Distinguish clearly: facts from query results vs. assumptions. State row
   counts from actual results, never estimates presented as counts.

Style: concise, analytical, plain English. Show the SQL you used when it helps
the user verify. You are one component of a zero-standing-cost Oracle: the
data lives on IPFS, you query it statelessly.
""".strip()

root_agent = Agent(
    name="oracle_property_agent",
    model=LiteLlm(model=f"azure/{DEPLOYMENT}", max_completion_tokens=2400),
    description=(
        "Answers property-intelligence questions (ownership tenure, roof age, "
        "location/distance, owner locality) over county public-record data "
        "served from IPFS, with source-backed evidence and CID provenance."
    ),
    instruction=INSTRUCTION,
    tools=[
        McpToolset(
            connection_params=StreamableHTTPConnectionParams(url=MCP_URL),
        )
    ],
)
