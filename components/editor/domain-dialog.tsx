"use client"

import React, { useState, useEffect } from "react"
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription, DialogFooter, DialogHeader } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"

type DomainInstructionRecord = {
  type: string
  name?: string
  value: string
}

type DomainInstructions = {
  note?: string
  records?: DomainInstructionRecord[]
  verifyDetails?: Record<string, unknown> | null
}

type DomainSaveResponse = {
  instructions?: DomainInstructions | null
  error?: string
}

type DomainVerifyResponse = {
  verified?: boolean
  details?: Record<string, unknown> | null
  error?: string
}

interface DomainDialogProps {
  projectId: string
  currentDomain?: string | null
  onDomainSaved?: (domain: string | null) => void
}

export default function DomainDialog({ projectId, currentDomain, onDomainSaved }: DomainDialogProps) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [domain, setDomain] = useState<string>(currentDomain || "")
  const [saving, setSaving] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verified, setVerified] = useState<boolean | null>(null)
  const [instructions, setInstructions] = useState<DomainInstructions | null>(null)

  useEffect(() => {
    setDomain(currentDomain || "")
    setVerified(null)
  }, [currentDomain, open])

  const handleSave = async () => {
    const trimmed = domain.trim()
    if (!trimmed) {
      toast({ title: "Domain kosong", description: "Masukkan domain yang valid." })
      return
    }

    setSaving(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/domain`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: trimmed }),
      })
      const data = (await res.json()) as DomainSaveResponse
      if (!res.ok) {
        throw new Error(data?.error || "Gagal menyimpan domain")
      }

      setInstructions(data.instructions || null)
      toast({ title: "Domain disimpan", description: `Domain ${trimmed} disimpan.` })
      onDomainSaved?.(trimmed)
    } catch (err) {
      console.error(err)
      toast({ title: "Error", description: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving(false)
    }
  }

  const handleVerify = async () => {
    const trimmed = domain.trim()
    if (!trimmed) {
      toast({ title: "Domain kosong", description: "Masukkan domain sebelum verifikasi." })
      return
    }

    setVerifying(true)
    setVerified(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/domain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: trimmed }),
      })
      const data = (await res.json()) as DomainVerifyResponse
      if (!res.ok) throw new Error(data?.error || "Gagal verifikasi")

      setVerified(Boolean(data.verified))
      toast({ title: data.verified ? "Domain terverifikasi" : "Belum terverifikasi", description: data.verified ? `Domain ${trimmed} sudah mengarah ke Vercel.` : "DNS belum terpropagasi atau pengaturan belum benar." })
      if (data.details) setInstructions((prev) => ({ ...(prev ?? {}), verifyDetails: data.details }))
      if (data.verified) onDomainSaved?.(trimmed)
    } catch (err) {
      console.error(err)
      toast({ title: "Error", description: err instanceof Error ? err.message : String(err) })
    } finally {
      setVerifying(false)
    }
  }

  const prettyInstructions = () => {
    if (!instructions) return null
    return (
      <div className="mt-3 text-sm text-muted-foreground">
        <div className="font-medium">Instruksi DNS</div>
        <div className="mt-2">
          {instructions.note && <div className="mb-2">{instructions.note}</div>}
          {Array.isArray(instructions.records) && (
            <ul className="list-disc ml-5">
              {instructions.records.map((r, idx: number) => (
                <li key={idx}>
                  <strong>{r.type}</strong> {r.name ? `${r.name} → ` : ""}{r.value}
                </li>
              ))}
            </ul>
          )}
          {instructions.verifyDetails && (
            <pre className="mt-3 rounded border bg-secondary p-2 text-xs">{JSON.stringify(instructions.verifyDetails, null, 2)}</pre>
          )}
        </div>
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          Domain
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Custom Domain</DialogTitle>
          <DialogDescription>
            Ganti domain pribadi untuk project ini. Setelah menyimpan, ikuti instruksi DNS dan klik Check DNS untuk memverifikasi.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-3 grid gap-2">
          <label className="text-sm text-muted-foreground">Domain</label>
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com or app.example.com" />
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave} disabled={saving}>{saving ? 'Menyimpan...' : 'Save'}</Button>
            <Button size="sm" onClick={handleVerify} disabled={verifying}>{verifying ? 'Checking...' : 'Check DNS'}</Button>
          </div>

          {verified === true && <div className="text-sm text-green-500">Domain terverifikasi.</div>}
          {verified === false && <div className="text-sm text-destructive">Domain belum terverifikasi.</div>}

          {prettyInstructions()}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
