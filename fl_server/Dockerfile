FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ cmake libpq-dev && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# fl_common is mounted via docker-compose volume
ENV PYTHONPATH=/app:/

EXPOSE 8080

CMD ["python", "server.py"]
