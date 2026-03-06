FROM python:3.11-slim

WORKDIR /app

RUN pip install poetry

COPY hackathons/agents/world-monitor-agent/pyproject.toml ./
RUN poetry install --no-root --no-interaction

COPY hackathons/agents/world-monitor-agent/src/ ./src/

EXPOSE 3000

CMD ["poetry", "run", "web"]
