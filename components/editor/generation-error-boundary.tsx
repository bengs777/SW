"use client"

import { Component, ReactNode } from "react"
import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class GenerationErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = {
      hasError: false,
      error: null,
    }
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
    }
  }

  componentDidCatch(error: Error, errorInfo: { componentStack: string }) {
    console.error("[v0] Generation error boundary caught:", error, errorInfo)
  }

  resetError = () => {
    this.setState({
      hasError: false,
      error: null,
    })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-full p-4 bg-destructive/5 border border-destructive/20 rounded-lg">
          <div className="text-center space-y-4 max-w-sm">
            <div className="flex justify-center">
              <AlertTriangle className="h-10 w-10 text-destructive" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground mb-2">Terjadi Kesalahan</h3>
              <p className="text-sm text-muted-foreground mb-4">
                {this.state.error?.message || "Kesalahan tidak diketahui terjadi saat mengproses kode yang di-generate."}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={this.resetError}
              className="w-full"
            >
              Coba Lagi
            </Button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
