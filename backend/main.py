# -*- coding: utf-8 -*-
"""
Revit Chat Backend
FastAPI server that connects to the Revit MCP (SSE) and uses OpenAI as the AI agent.
"""

import os
import json
import asyncio
import shutil
from pathlib import Path
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from openai import AsyncOpenAI
from mcp import ClientSession, StdioServerParameters
from mcp.client.sse import sse_client
from mcp.client.stdio import stdio_client

# ── Config ──────────────────────────────────────────────────────────────────
OPENAI_API_KEY  = os.environ.get("OPENAI_API_KEY", "")
MCP_SERVER_URL  = os.environ.get("MCP_SERVER_URL", "http://localhost:8000/sse")
MCP_SERVER_NAME = os.environ.get("MCP_SERVER_NAME", "RevitMCP")
OPENAI_MODEL    = "gpt-4o"
PROJECT_ROOT    = Path(__file__).resolve().parent.parent
MCP_CONFIG_PATH = Path(os.environ.get("MCP_CONFIG_PATH", PROJECT_ROOT / ".mcp.json"))

# ── App ──────────────────────────────────────────────────────────────────────
app = FastAPI(title="Revit Chat API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Expand for easier local dev
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

openai_client = AsyncOpenAI(api_key=OPENAI_API_KEY)


def load_stdio_server_params() -> tuple[StdioServerParameters | None, str | None]:
    """Load a stdio MCP server definition from .mcp.json when available."""
    if not MCP_CONFIG_PATH.exists():
        return None, None

    try:
        with MCP_CONFIG_PATH.open(encoding="utf-8") as f:
            config = json.load(f)
    except Exception as e:
        print(f"[MCP] Error reading config '{MCP_CONFIG_PATH}': {e}")
        return None, None

    server = config.get("mcpServers", {}).get(MCP_SERVER_NAME)
    if not server:
        return None, None

    command = server.get("command")
    if not command:
        print(f"[MCP] Server '{MCP_SERVER_NAME}' has no command in '{MCP_CONFIG_PATH}'")
        return None, None

    resolved_command = shutil.which(command) or command
    resolved_args = server.get("args", [])

    if command == "uv" and "mcp" in resolved_args and "run" in resolved_args:
        script_path = Path(resolved_args[-1])
        mcp_candidate = script_path.parent / "mcp_env" / "Scripts" / "mcp.exe"
        if script_path.suffix == ".py" and mcp_candidate.exists():
            resolved_command = str(mcp_candidate)
            resolved_args = ["run", str(script_path)]

    params_kwargs = {
        "command": resolved_command,
        "args": resolved_args,
        "env": server.get("env"),
    }
    if command == "uv" and "mcp" in server.get("args", []) and "run" in server.get("args", []):
        params_kwargs["cwd"] = str(Path(server.get("args", [])[-1]).parent)
        if Path(server.get("args", [])[-1]).suffix == ".py":
            params_kwargs["args"] = ["run", Path(server.get("args", [])[-1]).name]

    return (
        StdioServerParameters(**params_kwargs),
        str(MCP_CONFIG_PATH),
    )


STDIO_SERVER_PARAMS, STDIO_SERVER_SOURCE = load_stdio_server_params()


# ── Models ───────────────────────────────────────────────────────────────────
class Message(BaseModel):
    role: str   # "user" | "assistant"
    content: str

class ChatRequest(BaseModel):
    messages: list[Message]


# ── MCP helpers ──────────────────────────────────────────────────────────────
@asynccontextmanager
async def mcp_session():
    """Open an MCP session via stdio config first, then fallback to SSE."""
    if STDIO_SERVER_PARAMS is not None:
        print(f"[MCP] Attempting connection via STDIO: {STDIO_SERVER_PARAMS.command} {' '.join(STDIO_SERVER_PARAMS.args)}")
        try:
            async with stdio_client(STDIO_SERVER_PARAMS) as (read, write):
                async with ClientSession(read, write) as session:
                    print("[MCP] STDIO client created, initializing...")
                    await session.initialize()
                    print("[MCP] STDIO session initialized.")
                    yield session
                    return
        except Exception as e:
            print(
                f"[MCP] Error connecting via stdio using '{MCP_SERVER_NAME}' "
                f"from '{STDIO_SERVER_SOURCE}': {e}"
            )

    print(f"[MCP] Attempting connection via SSE: {MCP_SERVER_URL}")
    async with sse_client(MCP_SERVER_URL) as (read, write):
        async with ClientSession(read, write) as session:
            print("[MCP] SSE client created, initializing...")
            await session.initialize()
            print("[MCP] SSE session initialized.")
            yield session


async def get_mcp_tools() -> list[dict]:
    """Connect to MCP server and retrieve available tools with timeout."""
    print("[MCP] get_mcp_tools() called")
    try:
        async with asyncio.timeout(10.0): # 10s timeout
            async with mcp_session() as session:
                print("[MCP] Session opened, listing tools...")
                tools_result = await session.list_tools()
                print(f"[MCP] {len(tools_result.tools)} tools loaded successfully.")
                return [
                    {
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description or "",
                            "parameters": tool.inputSchema,
                        }
                    }
                    for tool in tools_result.tools
                ]
    except asyncio.TimeoutError:
        print("[MCP] Timeout fetching tools. Is the server responding?")
        return []
    except Exception as e:
        print(f"[MCP] Error fetching tools: {e}")
        return []


async def call_mcp_tool(tool_name: str, tool_input: dict) -> str:
    """Call a specific MCP tool and return the result as string."""
    try:
        async with mcp_session() as session:
            result = await session.call_tool(tool_name, tool_input)
            # Flatten content blocks to text
            parts = []
            for block in result.content:
                if hasattr(block, "text"):
                    parts.append(block.text)
                elif hasattr(block, "data"):
                    parts.append("[image data]")
                else:
                    parts.append(str(block))
            return "\\n".join(parts)
    except Exception as e:
        return f"Error calling tool '{tool_name}': {e}"


# ── Agent loop ────────────────────────────────────────────────────────────────
async def agent_stream(messages: list[dict]) -> AsyncGenerator[str, None]:
    """
    Agentic loop: call OpenAI → execute tool calls → repeat until final answer.
    Yields SSE-formatted strings.
    """

    def sse(event: str, data: dict) -> str:
        return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

    # 1. Fetch tools from MCP
    yield sse("status", {"message": "Conectando con Revit MCP..."})
    tools = await get_mcp_tools()

    if not tools:
        yield sse("error", {"message": "No se pudo conectar con el servidor MCP de Revit. ¿Está corriendo en el puerto 8000?"})
        return

    yield sse("status", {"message": f"{len(tools)} tools disponibles"})

    system_prompt = (
        "Eres un asistente experto en Autodesk Revit y su API de desarrollo (Revit API).\n"
        "Tienes acceso directo al modelo de Revit activo a través de herramientas MCP.\n"
        "Tu objetivo es ayudar al usuario a gestionar, consultar y automatizar tareas en su modelo de Revit.\n\n"
        
        "### REGLAS DE EXPERTO EN REVIT API:\n"
        "1. Tienes acceso a la herramienta 'execute_revit_code' para ejecutar scripts de IronPython 2.7.12 directamente en Revit.\n"
        "2. En el entorno de ejecución, dispones de las variables globales:\n"
        "   - `doc`: El objeto Document actual (Autodesk.Revit.DB.Document).\n"
        "   - `DB`: El namespace Autodesk.Revit.DB.\n"
        "   - `revit`: El módulo pyRevit para utilidades adicionales.\n"
        "3. El código que envíes ya se ejecuta dentro de una Transaction activa, por lo que NO debes crear una nueva manualmente.\n"
        "4. Siempre usa `print()` para devolver los resultados o datos que quieras mostrar al usuario.\n"
        "5. Para buscar elementos, utiliza `DB.FilteredElementCollector(doc)`.\n"
        "6. Si el código de la API falla, analiza el error y propón una corrección o usa una alternativa.\n\n"
        
        "### ESTILO DE GESTIÓN:\n"
        "- Eres preciso, eficiente y sigues las mejores prácticas de BIM.\n"
        "- Cuando ejecutes una herramienta, explica brevemente qué estás haciendo y por qué.\n"
        "- Si una tarea es compleja, desglósala en pasos y usa las herramientas MCP disponibles.\n"
        "- Responde siempre en el mismo idioma que el usuario."
    )

    api_messages = [{"role": "system", "content": system_prompt}]
    for m in messages:
        api_messages.append({"role": m["role"], "content": m["content"]})

    # 2. Agentic loop
    while True:
        print(f"[Agent] Calling OpenAI ({OPENAI_MODEL})...")
        response = await openai_client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=api_messages,
            tools=tools if tools else None
        )
        
        msg = response.choices[0].message
        
        text_content = msg.content
        tool_calls = msg.tool_calls

        # Stream any text content
        if text_content:
            yield sse("text", {"content": text_content})

        # If no tool calls → final answer, done
        if not tool_calls:
            yield sse("done", {})
            return

        # 3. Execute tool calls
        tool_results_msgs = []
        for tc in tool_calls:
            try:
                tc_args = json.loads(tc.function.arguments)
            except:
                tc_args = {}
                
            yield sse("tool_call", {
                "tool": tc.function.name,
                "input": tc_args,
                "message": f"Ejecutando: {tc.function.name}..."
            })

            result_text = await call_mcp_tool(tc.function.name, tc_args)

            yield sse("tool_result", {
                "tool": tc.function.name,
                "preview": result_text[:200] + ("..." if len(result_text) > 200 else "")
            })

            tool_results_msgs.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "name": tc.function.name,
                "content": result_text,
            })

        # 4. Append assistant turn + tool results and loop
        api_messages.append(msg.model_dump(exclude_none=True))
        api_messages.extend(tool_results_msgs)


# ── Routes ────────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/mcp/status")
async def get_status():
    """Verify if Revit is truly connected by calling get_revit_status tool."""
    try:
        async with asyncio.timeout(3.0):
            async with mcp_session() as session:
                try:
                    # 'get_revit_status' checks if Revit API is responding
                    await session.call_tool("get_revit_status", {})
                    return {"connected": True}
                except Exception as e:
                    print(f"[MCP Status] Revit API not responding: {e}")
                    return {"connected": False, "error": "Revit API not responding"}
    except Exception as e:
        print(f"[MCP Status] Session failed (MCP server down): {e}")
        return {"connected": False, "error": str(e)}


@app.get("/mcp/tools")
async def list_tools():
    """List all available MCP tools (for debugging)."""
    tools = await get_mcp_tools()
    
    # Also verify if Revit is alive
    is_revit_alive = False
    if tools:
        try:
            async with asyncio.timeout(3.0):
                async with mcp_session() as session:
                    await session.call_tool("get_revit_status", {})
                    is_revit_alive = True
        except:
            pass

    return {
        "tools": tools,
        "count": len(tools) if is_revit_alive else 0,
        "revit_alive": is_revit_alive
    }


@app.post("/chat")
async def chat(req: ChatRequest):
    """Main chat endpoint — streams SSE events."""
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY not set")

    messages = [m.model_dump() for m in req.messages]

    return StreamingResponse(
        agent_stream(messages),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
