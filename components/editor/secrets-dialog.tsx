"use client"

import { useState, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { KeyRound, Plus, Trash2, Eye, EyeOff, FileText, Check, AlertCircle } from "lucide-react"
import { Textarea } from "@/components/ui/textarea"

interface SecretsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  secrets: Record<string, string>
  onSaveSecrets: (secrets: Record<string, string>) => void
}

export function SecretsDialog({
  open,
  onOpenChange,
  secrets: initialSecrets,
  onSaveSecrets,
}: SecretsDialogProps) {
  const [secretsList, setSecretsList] = useState<Array<{ key: string; value: string; show: boolean }>>([])
  const [newKey, setNewKey] = useState("")
  const [newValue, setNewValue] = useState("")
  const [showBulkImport, setShowBulkImport] = useState(false)
  const [bulkEnvText, setBulkEnvText] = useState("")
  const [savedSuccess, setSavedSuccess] = useState(false)

  useEffect(() => {
    if (open) {
      const list = Object.entries(initialSecrets || {}).map(([key, value]) => ({
        key,
        value,
        show: false,
      }))
      setSecretsList(list)
      setSavedSuccess(false)
    }
  }, [open, initialSecrets])

  const handleAddSecret = (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    const trimmedKey = newKey.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_")
    if (!trimmedKey) return

    setSecretsList((prev) => {
      const existing = prev.findIndex((s) => s.key === trimmedKey)
      if (existing >= 0) {
        const next = [...prev]
        next[existing] = { key: trimmedKey, value: newValue, show: false }
        return next
      }
      return [...prev, { key: trimmedKey, value: newValue, show: false }]
    })

    setNewKey("")
    setNewValue("")
  }

  const handleDeleteSecret = (keyToDelete: string) => {
    setSecretsList((prev) => prev.filter((s) => s.key !== keyToDelete))
  }

  const handleToggleShow = (index: number) => {
    setSecretsList((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], show: !next[index].show }
      return next
    })
  }

  const handleBulkImport = () => {
    const lines = bulkEnvText.split("\n")
    const newItems: Record<string, string> = {}

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line || line.startsWith("#")) continue
      const eqIdx = line.indexOf("=")
      if (eqIdx > 0) {
        const k = line.slice(0, eqIdx).trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_")
        let v = line.slice(eqIdx + 1).trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1)
        }
        if (k) {
          newItems[k] = v
        }
      }
    }

    setSecretsList((prev) => {
      const currentMap = Object.fromEntries(prev.map((s) => [s.key, s.value]))
      const merged = { ...currentMap, ...newItems }
      return Object.entries(merged).map(([key, value]) => ({ key, value, show: false }))
    })

    setShowBulkImport(false)
    setBulkEnvText("")
  }

  const handleSave = () => {
    const finalMap = Object.fromEntries(secretsList.map((s) => [s.key, s.value]))
    onSaveSecrets(finalMap)
    setSavedSuccess(true)
    setTimeout(() => {
      onOpenChange(false)
      setSavedSuccess(false)
    }, 600)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-6 overflow-hidden">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-amber-500" />
            <DialogTitle className="text-lg font-semibold">Environment Variables & Secrets</DialogTitle>
          </div>
          <DialogDescription className="text-xs text-muted-foreground">
            Kelola variabel lingkungan (API keys, secrets, database URL). Variabel ini otomatis disuntikkan ke dalam runtime container &amp; berkas <code className="bg-muted px-1 rounded">.env</code> sandbox.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 py-2 pr-1">
          {/* Add form */}
          <form onSubmit={handleAddSecret} className="p-3 bg-muted/30 border border-border/70 rounded-xl space-y-3">
            <div className="text-xs font-semibold text-foreground flex items-center justify-between">
              <span>Tambah Variable Baru</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowBulkImport((prev) => !prev)}
                className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground gap-1"
              >
                <FileText className="h-3 w-3" />
                {showBulkImport ? "Tutup Import .env" : "Import Format .env"}
              </Button>
            </div>

            {showBulkImport ? (
              <div className="space-y-2">
                <Textarea
                  value={bulkEnvText}
                  onChange={(e) => setBulkEnvText(e.target.value)}
                  placeholder="Paste isi .env di sini:&#10;OPENAI_API_KEY=sk-...&#10;DATABASE_URL=postgres://...&#10;STRIPE_SECRET_KEY=..."
                  className="font-mono text-xs h-24"
                />
                <Button type="button" size="sm" onClick={handleBulkImport} className="text-xs">
                  Import Variabel
                </Button>
              </div>
            ) : (
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="flex-1">
                  <Input
                    placeholder="KEY (contoh: OPENAI_API_KEY)"
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    className="h-8 font-mono text-xs uppercase"
                  />
                </div>
                <div className="flex-1">
                  <Input
                    placeholder="VALUE (contoh: sk-proj-...)"
                    type="password"
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    className="h-8 font-mono text-xs"
                  />
                </div>
                <Button type="submit" size="sm" className="h-8 px-3 text-xs gap-1 shrink-0">
                  <Plus className="h-3.5 w-3.5" />
                  Tambah
                </Button>
              </div>
            )}
          </form>

          {/* List of secrets */}
          <div className="space-y-2">
            <div className="text-xs font-semibold text-muted-foreground flex items-center justify-between px-1">
              <span>Daftar Secrets ({secretsList.length})</span>
            </div>

            {secretsList.length === 0 ? (
              <div className="p-6 text-center border border-dashed border-border/80 rounded-xl text-muted-foreground text-xs">
                Belum ada environment variable yang ditambahkan.
              </div>
            ) : (
              <div className="border border-border/70 rounded-xl divide-y divide-border/50 overflow-hidden bg-card">
                {secretsList.map((item, idx) => (
                  <div key={item.key} className="flex items-center justify-between p-2.5 gap-2 hover:bg-muted/20 transition-colors">
                    <div className="font-mono text-xs font-semibold text-foreground shrink-0 min-w-[140px] truncate">
                      {item.key}
                    </div>

                    <div className="flex-1 min-w-0 font-mono text-xs text-muted-foreground truncate bg-muted/30 px-2 py-1 rounded">
                      {item.show ? item.value : "•".repeat(Math.min(item.value.length || 8, 24))}
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => handleToggleShow(idx)}
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                        title={item.show ? "Sembunyikan" : "Tampilkan nilai"}
                      >
                        {item.show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => handleDeleteSecret(item.key)}
                        className="h-7 w-7 p-0 text-red-500 hover:text-red-600 hover:bg-red-500/10"
                        title="Hapus secret"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="pt-2 border-t border-border/60 flex items-center justify-between">
          <div className="text-[11px] text-muted-foreground flex items-center gap-1">
            <AlertCircle className="h-3 w-3 text-amber-500" />
            Nilai terenkripsi dan aman di level workspace.
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Batal
            </Button>
            <Button size="sm" onClick={handleSave} className="gap-1 bg-amber-600 hover:bg-amber-700 text-white">
              {savedSuccess ? <Check className="h-3.5 w-3.5" /> : null}
              {savedSuccess ? "Tersimpan" : "Simpan & Terapkan"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
