#!/usr/bin/env bash
# Paleidžia programą adresu http://127.0.0.1:8000
set -e
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
