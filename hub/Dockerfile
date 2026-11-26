# syntax=docker/dockerfile:1
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    GTC_HUB_DATA=/data

WORKDIR /app

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Keep the package layout: app.py imports `hub.store`, and `hub.app:app` is the
# supported ASGI entry point.
COPY __init__.py ./hub/__init__.py
COPY app.py ./hub/app.py
COPY store.py ./hub/store.py

# The SQLite database lives on a volume so recreating the container keeps state.
VOLUME ["/data"]
EXPOSE 8765

# Bind 0.0.0.0 inside the container; never publish it to the internet without
# a token and a private network in front of it.
CMD ["python", "-m", "uvicorn", "hub.app:app", "--host", "0.0.0.0", "--port", "8765"]
