FROM python:3.11-slim

WORKDIR /app

# Prevent Python from writing .pyc bytecode cache files.
# This avoids stale-cache bugs when source is volume-mounted at runtime.
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ cmake && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# fl_common is mounted via docker-compose volume
ENV PYTHONPATH=/app:/

CMD ["python", "client.py"]
