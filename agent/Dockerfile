# Oracle deliverable agent — ADK + Azure GPT-5.4, exposed as an A2A endpoint.
FROM python:3.12-slim

WORKDIR /app
RUN pip install --no-cache-dir uv

# deps first (cache layer)
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen

# app code
COPY oracle_agent ./oracle_agent
COPY a2a_server.py ./

ENV PORT=8788
EXPOSE 8788
CMD ["sh", "-c", "uv run uvicorn a2a_server:app --host 0.0.0.0 --port ${PORT}"]
