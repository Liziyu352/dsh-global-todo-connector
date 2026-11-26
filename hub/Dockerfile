# syntax=docker/dockerfile:1
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    GTC_HUB_DATA=/data

WORKDIR /app

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Keep the package layout: the modules import each other as `hub.*`, so the
# directory has to stay a package rather than being flattened into /app.
COPY __init__.py ./hub/__init__.py
COPY app.py ./hub/app.py
COPY store.py ./hub/store.py
COPY files.py ./hub/files.py
COPY request.py ./hub/request.py
COPY watcher.py ./hub/watcher.py

# The SQLite database lives on a volume so recreating the container keeps state.
VOLUME ["/data"]
EXPOSE 8765

# Run the CLI entry point (not `uvicorn hub.app:app`) so container operators can
# append flags such as `--todo-store /todos/todos.json` or `--no-watcher`
# through `docker run ... ` / `command:` in compose.
#
# Bind 0.0.0.0 inside the container; never publish it to the internet without
# a token and a private network in front of it.
CMD ["python", "-m", "hub.app", "--host", "0.0.0.0", "--port", "8765"]
