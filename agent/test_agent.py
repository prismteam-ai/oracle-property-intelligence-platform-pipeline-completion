"""Local smoke test: one demo question through the full stack.

agent (GPT-5.4 via Azure) -> MCP (localhost:8787) -> DuckDB -> Parquet on IPFS.
Run: uv run python test_agent.py ["question"]
"""

import asyncio
import sys

from google.adk.runners import InMemoryRunner
from google.genai import types

from oracle_agent.agent import root_agent

QUESTION = (
    sys.argv[1]
    if len(sys.argv) > 1
    else "How many properties are in the dataset, and how many have coordinates? "
    "Then show me 3 properties in Cape Coral with their provenance CIDs."
)


async def main() -> int:
    runner = InMemoryRunner(agent=root_agent, app_name="oracle-smoke")
    session = await runner.session_service.create_session(
        app_name="oracle-smoke", user_id="smoke"
    )
    content = types.Content(role="user", parts=[types.Part(text=QUESTION)])
    final = None
    async for event in runner.run_async(
        user_id="smoke", session_id=session.id, new_message=content
    ):
        if event.get_function_calls():
            for fc in event.get_function_calls():
                print(f"[tool call] {fc.name}({str(fc.args)[:200]})")
        if event.is_final_response() and event.content and event.content.parts:
            final = "".join(p.text or "" for p in event.content.parts)
    print("\n=== FINAL ANSWER ===\n")
    print(final or "(no final response)")
    return 0 if final else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
