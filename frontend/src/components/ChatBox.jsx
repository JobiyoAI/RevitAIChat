import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Send, Bot, User, Wrench, CheckCircle2, AlertCircle,
  Wifi, WifiOff, ChevronDown, ChevronUp, Building2
} from 'lucide-react'

// ── SSE streaming helper ──────────────────────────────────────────────────────
async function* streamChat(messages) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`HTTP ${res.status}: ${err}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() // keep incomplete line
    let event = null
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        event = line.slice(7).trim()
      } else if (line.startsWith('data: ')) {
        const data = JSON.parse(line.slice(6))
        if (event) yield { event, data }
        event = null
      }
    }
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────
function ToolBadge({ call }) {
  const [open, setOpen] = useState(false)
  const isResult = call.type === 'result'

  return (
    <div
      className={`rounded-md border text-xs font-mono my-1 overflow-hidden transition-all ${
        isResult
          ? 'border-[#1e3a2e] bg-[#0d1f18]'
          : 'border-[#1e2a3a] bg-[#0d1520]'
      }`}
    >
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/5 transition-colors"
      >
        {isResult
          ? <CheckCircle2 size={12} className="text-[#3ecf8e] shrink-0" />
          : <Wrench size={12} className="text-[#4f8ef7] shrink-0 animate-spin" style={{ animationDuration: '2s' }} />
        }
        <span className={isResult ? 'text-[#3ecf8e]' : 'text-[#4f8ef7]'}>
          {isResult ? '✓' : '⚙'} {call.tool}
        </span>
        <span className="ml-auto text-[#4a5568]">
          {open ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-2 border-t border-white/5 pt-2 text-[#8899aa] leading-relaxed whitespace-pre-wrap break-all">
          {isResult
            ? call.preview
            : JSON.stringify(call.input, null, 2)
          }
        </div>
      )}
    </div>
  )
}

function StatusPill({ text }) {
  return (
    <div className="flex items-center gap-2 text-xs text-[#4a5568] py-1">
      <div className="dot-pulse">
        <span /><span /><span />
      </div>
      <span>{text}</span>
    </div>
  )
}

function MessageBubble({ msg }) {
  const isUser = msg.role === 'user'

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* Avatar */}
      <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center
        ${isUser ? 'bg-[#1e2a4a]' : 'bg-[#1a2035]'}`}>
        {isUser
          ? <User size={14} className="text-[#4f8ef7]" />
          : <Bot  size={14} className="text-[#3ecf8e]" />
        }
      </div>

      {/* Content */}
      <div className={`flex flex-col gap-1 max-w-[80%] ${isUser ? 'items-end' : 'items-start'}`}>
        <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap
          ${isUser
            ? 'bg-[#1e2a4a] text-[#e2e8f0] rounded-tr-sm'
            : 'bg-[#151820] text-[#e2e8f0] rounded-tl-sm border border-[#1e2535]'
          }
          ${msg.streaming ? 'cursor-blink' : ''}
        `}>
          {msg.content || (msg.streaming ? '' : '…')}
        </div>

        {/* Tool calls */}
        {msg.toolCalls && msg.toolCalls.length > 0 && (
          <div className="w-full">
            {msg.toolCalls.map((tc, i) => <ToolBadge key={i} call={tc} />)}
          </div>
        )}

        {/* Status pills */}
        {msg.status && <StatusPill text={msg.status} />}

        {/* Error */}
        {msg.error && (
          <div className="flex items-center gap-1 text-xs text-[#f05050] px-1">
            <AlertCircle size={11} />
            <span>{msg.error}</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Suggested prompts ─────────────────────────────────────────────────────────
const SUGGESTIONS = [
  '¿Cuántos muros hay en el modelo?',
  'Lista todas las vistas disponibles',
  'Dame información del modelo actual',
  '¿Qué niveles tiene el proyecto?',
  'Colorea los muros por tipo',
]

// ── Main ChatBox ──────────────────────────────────────────────────────────────
export default function ChatBox() {
  const [messages, setMessages] = useState([])
  const [input, setInput]       = useState('')
  const [loading, setLoading]   = useState(false)
  const [connected, setConnected] = useState(null) // null=unknown, true, false
  const bottomRef = useRef(null)
  const textareaRef = useRef(null)

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Check Revit connection on mount and every 10s
  const checkConnection = useCallback(() => {
    fetch('/api/mcp/tools')
      .then(r => r.json())
      .then(d => setConnected(!!d.revit_alive))
      .catch(() => setConnected(false))
  }, [])

  useEffect(() => {
    checkConnection()
    const int = setInterval(checkConnection, 10000)
    return () => clearInterval(int)
  }, [checkConnection])

  const sendMessage = useCallback(async (text) => {
    const userText = (text || input).trim()
    if (!userText || loading) return

    setInput('')
    setLoading(true)

    const userMsg = { role: 'user', content: userText }
    const history = [...messages, userMsg]

    setMessages(prev => [
      ...prev,
      { ...userMsg, id: Date.now() },
      { id: Date.now() + 1, role: 'assistant', content: '', streaming: true, toolCalls: [], status: 'Conectando...' },
    ])

    try {
      const apiMessages = history.map(m => ({ role: m.role, content: m.content }))

      for await (const { event, data } of streamChat(apiMessages)) {
        setMessages(prev => {
          const msgs = [...prev]
          const last = { ...msgs[msgs.length - 1] }

          if (event === 'status') {
            last.status = data.message
          } else if (event === 'text') {
            last.content  = (last.content || '') + data.content
            last.status   = null
            last.streaming = true
          } else if (event === 'tool_call') {
            last.status = data.message
            last.toolCalls = [...(last.toolCalls || []), {
              type: 'call', tool: data.tool, input: data.input
            }]
          } else if (event === 'tool_result') {
            // Update last tool call to show result
            const tcs = [...(last.toolCalls || [])]
            const idx = tcs.map(t => t.tool).lastIndexOf(data.tool)
            if (idx !== -1) tcs[idx] = { ...tcs[idx], type: 'result', preview: data.preview }
            last.toolCalls = tcs
            last.status = null
          } else if (event === 'error') {
            last.error = data.message
            last.status = null
            last.streaming = false
          } else if (event === 'done') {
            last.streaming = false
            last.status = null
          }

          msgs[msgs.length - 1] = last
          return msgs
        })
      }
    } catch (err) {
      setMessages(prev => {
        const msgs = [...prev]
        msgs[msgs.length - 1] = {
          ...msgs[msgs.length - 1],
          error: err.message,
          streaming: false,
          status: null,
        }
        return msgs
      })
    } finally {
      setLoading(false)
    }
  }, [input, messages, loading])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const isEmpty = messages.length === 0

  return (
    <div className="w-full h-full max-w-3xl flex flex-col font-sans">

      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-[#1e2535]">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[#151820] border border-[#1e2535] flex items-center justify-center">
            <Building2 size={18} className="text-[#4f8ef7]" />
          </div>
          <div>
            <h1 className="text-[#e2e8f0] font-semibold text-sm tracking-wide">Revit AI</h1>
            <p className="text-[#4a5568] text-xs font-mono">MCP Agent</p>
          </div>
        </div>

        {/* Connection status */}
        <div className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border
          ${connected === true
            ? 'border-[#1e3a2e] bg-[#0d1f18] text-[#3ecf8e]'
            : connected === false
            ? 'border-[#3a1e1e] bg-[#1f0d0d] text-[#f05050]'
            : 'border-[#1e2535] bg-[#151820] text-[#4a5568]'
          }`}>
          {connected === true
            ? <><Wifi size={11} /><span>Revit conectado</span></>
            : connected === false
            ? <><WifiOff size={11} /><span>Revit desconectado</span></>
            : <><span className="w-2 h-2 rounded-full bg-[#4a5568] animate-pulse" /><span>Verificando...</span></>
          }
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">

        {isEmpty && (
          <div className="flex-1 flex flex-col items-center justify-center gap-6 text-center py-12">
            <div className="w-16 h-16 rounded-2xl bg-[#151820] border border-[#1e2535] flex items-center justify-center">
              <Building2 size={28} className="text-[#4f8ef7]" />
            </div>
            <div>
              <h2 className="text-[#e2e8f0] font-semibold text-lg mb-1">Asistente de Revit</h2>
              <p className="text-[#4a5568] text-sm max-w-xs leading-relaxed">
                Pregúntame sobre tu modelo activo. Puedo consultar elementos, vistas, niveles, coloreados y más.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 justify-center max-w-md">
              {SUGGESTIONS.map((s, i) => (
                <button
                  key={i}
                  onClick={() => sendMessage(s)}
                  className="text-xs px-3 py-2 rounded-xl border border-[#1e2535] bg-[#151820]
                    text-[#8899aa] hover:text-[#e2e8f0] hover:border-[#4f8ef7] hover:bg-[#1a2035]
                    transition-all duration-200"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map(msg => (
          <MessageBubble key={msg.id} msg={msg} />
        ))}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 px-6 pb-6 pt-3 border-t border-[#1e2535]">
        <div className="flex items-end gap-3 bg-[#151820] border border-[#1e2535] rounded-2xl px-4 py-3
          focus-within:border-[#4f8ef7] transition-colors duration-200">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Pregunta algo sobre tu modelo de Revit..."
            rows={1}
            disabled={loading}
            className="flex-1 bg-transparent text-[#e2e8f0] text-sm resize-none outline-none
              placeholder-[#4a5568] font-sans leading-relaxed
              disabled:opacity-50"
            style={{ maxHeight: '120px', overflowY: 'auto' }}
          />
          <button
            onClick={() => sendMessage()}
            disabled={loading || !input.trim()}
            className="shrink-0 w-8 h-8 rounded-xl bg-[#4f8ef7] flex items-center justify-center
              hover:bg-[#6aa3f9] disabled:opacity-30 disabled:cursor-not-allowed
              transition-all duration-200 hover:scale-105 active:scale-95"
          >
            <Send size={14} className="text-white" />
          </button>
        </div>
        <p className="text-center text-[#2a3040] text-xs mt-2 font-mono">
          Enter para enviar · Shift+Enter nueva línea
        </p>
      </div>

    </div>
  )
}
