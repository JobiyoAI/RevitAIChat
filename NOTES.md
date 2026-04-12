Para arrancar la app:

  # 1. Backend (terminal 1)
  cd backend
  cp .env.example .env
  # Edita .env y añade tu ANTHROPIC_API_KEY
  pip install -r requirements.txt
  python run.py

  # 2. Frontend (terminal 2)
  cd frontend
  npm install
  npm run dev
  # → http://localhost:5173

  Requisitos: Python 3.11+, uv o pip, Node.js 18+, y el MCP de Revit corriendo en :8000.

# GITHUB Token
# Agrega tu token aquí

# Añadir token
PS> $env:GITHUB_PERSONAL_ACCESS_TOKEN="TU_TOKEN"



Added stdio MCP server github with command: npx -y @modelcontextprotocol/server-github to local config


# ------------------------------------------
# Ruta configuración MCP Codex
C:\USERS\JAVI\.codex\config.toml
# ------------------------------------------



# ------------------------------------------
# Seleccionar modelo gratuito de OPENROUTER
# Edita settings.local.json con tu token de OpenRouter
# ------------------------------------------
