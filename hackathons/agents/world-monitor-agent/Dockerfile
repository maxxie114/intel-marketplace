FROM python:3.11-slim

WORKDIR /app

RUN pip install poetry

COPY pyproject.toml ./
RUN poetry install --no-root --no-interaction

COPY src/ ./src/

EXPOSE 3000

CMD ["poetry", "run", "python", "-m", "src.web"]
