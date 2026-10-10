"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Terminal as TerminalIcon, RefreshCw, Trash2, Send, CornerDownLeft, Play } from "lucide-react"
import { Input } from "@/components/ui/input"
import "@xterm/xterm/css/xterm.css"

interface TerminalPanelProps {
  projectId: string
  runtimePreviewUrl?: string | null
  className?: string
}

export function TerminalPanel({
  projectId,
  runtimePreviewUrl = null,
  className = "",
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<any>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fitAddonRef = useRef<any>(null)
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "connected" | "disconnected">("connecting")
  const [commandInput, setCommandInput] = useState("")

  const resolveWsUrl = useCallback(() => {
    if (typeof window === "undefined" || !projectId) return ""

    // Priority 1: Explicit public sandbox service URL if configured
    const envUrl = process.env.NEXT_PUBLIC_SANDBOX_SERVICE_URL
    if (envUrl) {
      try {
        const url = new URL(envUrl)
        const protocol = url.protocol === "https:" ? "wss:" : "ws:"
        return `${protocol}//${url.host}/terminal/${encodeURIComponent(projectId)}`
      } catch {
        // Fallback below
      }
    }

    // Priority 2: Terminal Gateway on current Swift origin
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
    return `${protocol}//${window.location.host}/terminal/${encodeURIComponent(projectId)}`
  }, [projectId])

  const connectTerminal = useCallback(async () => {
    if (!containerRef.current) return

    setConnectionStatus("connecting")

    // Import xterm modules dynamically
    const { Terminal } = await import("@xterm/xterm")
    const { FitAddon } = await import("@xterm/addon-fit")

    if (termRef.current) {
      termRef.current.dispose()
    }
    if (wsRef.current) {
      wsRef.current.close()
    }

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: "#09090b",
        foreground: "#f4f4f5",
        cursor: "#a1a1aa",
        black: "#18181b",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#f4f4f5",
        brightBlack: "#71717a",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#fde047",
        brightBlue: "#60a5fa",
        brightMagenta: "#c084fc",
        brightCyan: "#22d3ee",
        brightWhite: "#ffffff",
      },
      convertEol: true,
      scrollback: 1000,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    containerRef.current.innerHTML = ""
    term.open(containerRef.current)
    fitAddon.fit()

    termRef.current = term
    fitAddonRef.current = fitAddon

    const wsUrl = resolveWsUrl()
    if (!wsUrl) {
      term.writeln("\x1b[31m[WebSocket endpoint not resolved. Start the runtime preview first.]\x1b[0m")
      setConnectionStatus("disconnected")
      return
    }

    term.writeln(`\x1b[90mConnecting to container terminal: ${wsUrl}...\x1b[0m`)

    try {
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setConnectionStatus("connected")
        term.focus()
      }

      ws.onmessage = (event) => {
        term.write(event.data)
      }

      ws.onerror = () => {
        setConnectionStatus("disconnected")
        term.writeln("\r\n\x1b[31m[Terminal connection error. Ensure sandbox runtime is running.]\x1b[0m\r\n")
      }

      ws.onclose = () => {
        setConnectionStatus("disconnected")
        term.writeln("\r\n\x1b[33m[Terminal connection closed.]\x1b[0m\r\n")
      }

      term.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }))
        }
      })
    } catch (err: any) {
      setConnectionStatus("disconnected")
      term.writeln(`\r\n\x1b[31m[Failed to connect: ${err?.message || String(err)}]\x1b[0m\r\n`)
    }
  }, [projectId, resolveWsUrl])

  useEffect(() => {
    connectTerminal()

    const handleResize = () => {
      try {
        fitAddonRef.current?.fit()
      } catch {}
    }

    window.addEventListener("resize", handleResize)
    return () => {
      window.removeEventListener("resize", handleResize)
      if (wsRef.current) {
        wsRef.current.close()
      }
      if (termRef.current) {
        termRef.current.dispose()
      }
    }
  }, [connectTerminal])

  const handleClear = () => {
    termRef.current?.clear()
  }

  const executeCommand = async (cmd: string) => {
    const trimmed = cmd.trim()
    if (!trimmed) return

    // If WebSocket is connected, send via PTY
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "input", data: trimmed + "\n" }))
      return
    }

    // Fallback: execute via Swift project terminal exec API
    termRef.current?.writeln(`\r\n\x1b[36m$ ${trimmed}\x1b[0m`)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/terminal/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: trimmed }),
      })
      const data = await res.json()
      if (data.stdout) {
        termRef.current?.writeln(data.stdout.replace(/\n/g, "\r\n"))
      }
      if (data.stderr) {
        termRef.current?.writeln(`\x1b[31m${data.stderr.replace(/\n/g, "\r\n")}\x1b[0m`)
      }
      if (data.error) {
        termRef.current?.writeln(`\x1b[31m[Error: ${data.error}]\x1b[0m`)
      }
    } catch (err: any) {
      termRef.current?.writeln(`\x1b[31m[Command execution error: ${err?.message || String(err)}]\x1b[0m`)
    }
  }

  const handleQuickCommandSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!commandInput.trim()) return
    const cmd = commandInput
    setCommandInput("")
    void executeCommand(cmd)
  }

  const runQuickCommand = (cmd: string) => {
    void executeCommand(cmd)
  }

  return (
    <div className={`flex flex-col h-full bg-[#09090b] text-foreground border border-border/80 rounded-xl overflow-hidden ${className}`}>
      {/* Top status bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/60 bg-muted/20 text-xs">
        <div className="flex items-center gap-2">
          <TerminalIcon className="h-4 w-4 text-emerald-400" />
          <span className="font-semibold text-foreground tracking-tight">Interactive Shell</span>
          <Badge
            variant="outline"
            className={`text-[10px] uppercase font-mono px-1.5 py-0.5 ${
              connectionStatus === "connected"
                ? "border-emerald-500/50 text-emerald-400 bg-emerald-950/20"
                : connectionStatus === "connecting"
                ? "border-amber-500/50 text-amber-400 bg-amber-950/20"
                : "border-red-500/50 text-red-400 bg-red-950/20"
            }`}
          >
            {connectionStatus}
          </Badge>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => runQuickCommand("ls -la")}
            className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            title="List files"
          >
            ls
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => runQuickCommand("npm -v || python --version")}
            className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            title="Check runtime version"
          >
            runtime
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleClear}
            className="h-7 px-2 text-[11px] text-muted-foreground hover:text-foreground gap-1"
            title="Clear terminal"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={connectTerminal}
            className="h-7 px-2 text-[11px] gap-1"
            title="Reconnect shell"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Reconnect
          </Button>
        </div>
      </div>

      {/* Terminal Viewport */}
      <div className="flex-1 min-h-0 p-2 relative bg-[#09090b]">
        <div ref={containerRef} className="w-full h-full" />
      </div>

      {/* Bottom Command Prompt Bar for fast typing */}
      <form onSubmit={handleQuickCommandSubmit} className="flex items-center gap-2 px-3 py-2 border-t border-border/60 bg-muted/10">
        <span className="text-muted-foreground font-mono text-xs select-none">$</span>
        <Input
          value={commandInput}
          onChange={(e) => setCommandInput(e.target.value)}
          placeholder="Ketik command lalu Enter (contoh: npm install lodash, python app.py, cat .env)..."
          className="h-7 text-xs font-mono bg-background/50 border-border/50 text-foreground flex-1"
        />
        <Button
          type="submit"
          size="sm"
          disabled={!commandInput.trim()}
          className="h-7 px-2.5 text-xs gap-1"
        >
          <Send className="h-3 w-3" />
          Kirim
        </Button>
      </form>
    </div>
  )
}
