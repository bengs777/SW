import os from 'os'
import path from 'path'

export function getReportStoragePath(): string {
  if (process.env.VERCEL) {
    return path.join(os.tmpdir(), 'swift-reports')
  }

  return path.join(process.cwd(), '.swift-reports')
}
