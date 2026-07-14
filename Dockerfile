FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn
COPY pipeline/ pipeline/
ENV DATA_DIR=/data HOST=0.0.0.0 PORT=5050
# web UI/API by default; MCP app overrides the command
CMD ["sh", "-c", "gunicorn -w 2 -b 0.0.0.0:${PORT} --timeout 600 pipeline.server:app"]
