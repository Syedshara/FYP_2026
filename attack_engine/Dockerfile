FROM python:3.11-slim

LABEL maintainer="IoT IDS Platform" \
      description="Scapy-based attack engine for synthetic traffic generation"

# Install system deps for Scapy (raw sockets, tcpdump, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
        tcpdump \
        libpcap-dev \
        iproute2 \
        iputils-ping \
        net-tools \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /engine

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Scapy needs NET_RAW + NET_ADMIN capabilities (added via docker run --cap-add)
ENTRYPOINT ["python", "-u", "entrypoint.py"]
