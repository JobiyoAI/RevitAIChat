#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Entry point para el backend de Revit Chat.
Carga variables de entorno desde .env y arranca uvicorn.
"""

import os
import sys
from pathlib import Path

# Cargar .env si existe
env_path = Path(__file__).parent / ".env"
if env_path.exists():
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            key, sep, value = line.partition("=")
            if sep and key:
                os.environ.setdefault(key.strip(), value.strip())

# Verificar OPENAI_API_KEY
if not os.environ.get("OPENAI_API_KEY"):
    print("ERROR: OPENAI_API_KEY no está configurada.")
    print("Copia .env.example a .env y añade tu API key.")
    sys.exit(1)

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8001,
        reload=True,
        log_level="info",
    )
