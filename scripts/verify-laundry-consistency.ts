import { db } from "@/lib/db/client"
import { projectFiles, generationJobs } from "@/lib/db/schema"
import { eq, desc } from "drizzle-orm"
import fs from "node:fs"
import path from "node:path"
import http from "node:http"

const PROJECT_ID = "prj_ms8re9qotmnr4ig7"

function httpGet(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let data = ""
      res.on("data", (chunk) => data += chunk)
      res.on("end", () => resolve(data))
    })
    req.on("error", reject)
  })
}

async function main() {
  console.log("=================================================");
  console.log("       CROSS-TIER LAUNDRY KU CONSISTENCY CHECK   ");
  console.log("=================================================");

  // 1. Database projectFiles
  const dbFiles = await db.select().from(projectFiles).where(eq(projectFiles.projectId, PROJECT_ID))
  console.log(`\n1. Database projectFiles: ${dbFiles.length} files`)
  const dbPage = dbFiles.find(f => f.path === "app/page.tsx")?.content || ""
  const dbBooking = dbFiles.find(f => f.path === "app/booking/page.tsx")?.content || ""
  const dbLayout = dbFiles.find(f => f.path === "app/layout.tsx")?.content || ""

  console.log("   - app/page.tsx has Laundry Ku HeroSection:", dbPage.includes("HeroSection"))
  console.log("   - app/layout.tsx title:", dbLayout.match(/title:\s*"([^"]+)"/)?.[1] || "none")
  console.log("   - app/booking/page.tsx heading:", dbBooking.includes("Formulir Pesanan Laundry"))

  // 2. Active Sandbox on Disk (.swift-sandboxes/prj_ms8re9qotmnr4ig7)
  const diskPage = fs.readFileSync(path.join(process.cwd(), ".swift-sandboxes", PROJECT_ID, "app", "page.tsx"), "utf8")
  const diskLayout = fs.readFileSync(path.join(process.cwd(), ".swift-sandboxes", PROJECT_ID, "app", "layout.tsx"), "utf8")
  const diskBooking = fs.readFileSync(path.join(process.cwd(), ".swift-sandboxes", PROJECT_ID, "app", "booking", "page.tsx"), "utf8")
  console.log("\n2. Active Sandbox on Disk:")
  console.log("   - app/page.tsx matches DB content:", diskPage === dbPage)
  console.log("   - app/layout.tsx matches DB content:", diskLayout === dbLayout)
  console.log("   - app/booking/page.tsx matches DB content:", diskBooking === dbBooking)

  // 3. Database generationJobs.previewUrl
  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.projectId, PROJECT_ID)).orderBy(desc(generationJobs.createdAt)).limit(1)
  console.log("\n3. Latest generationJob:")
  console.log("   - Job ID:", job?.id)
  console.log("   - Job Status:", job?.status)
  console.log("   - previewUrl:", job?.previewUrl)

  // 4. Upstream Port 4688 Runtime Content
  const port4688Html = await httpGet("http://127.0.0.1:4688/")
  console.log("\n4. Upstream Port 4688 Content:")
  console.log("   - Contains 'Laundry Ku':", port4688Html.includes("Laundry Ku"))
  console.log("   - Contains 'Cuci Kiloan & Satuan':", port4688Html.includes("Cuci Kiloan"))
  console.log("   - Contains 'Swift scaffold ready' (fallback):", port4688Html.includes("Swift scaffold ready"))

  // 5. Preview Gateway Content
  const gatewayHtml = await httpGet(`http://127.0.0.1:3000/preview/${PROJECT_ID}?previewToken=valid`, {
    Referer: `http://localhost:3000/dashboard/project/${PROJECT_ID}`,
  })
  console.log("\n5. Preview Gateway Content:")
  console.log("   - Contains 'Laundry Ku':", gatewayHtml.includes("Laundry Ku"))
  console.log("   - Contains 'Cuci Kiloan & Satuan':", gatewayHtml.includes("Cuci Kiloan"))
  console.log("   - Contains 'Swift scaffold ready' (fallback):", gatewayHtml.includes("Swift scaffold ready"))

  const allAligned =
    diskPage === dbPage &&
    diskLayout === dbLayout &&
    diskBooking === dbBooking &&
    job?.previewUrl === "http://127.0.0.1:4688" &&
    port4688Html.includes("Laundry Ku") &&
    !port4688Html.includes("Swift scaffold ready") &&
    gatewayHtml.includes("Laundry Ku") &&
    !gatewayHtml.includes("Swift scaffold ready")

  console.log("\nConsistency Status:", allAligned ? "ALL TIERS PERFECTLY ALIGNED (PASS)" : "MISMATCH (FAIL)")
}

main().catch(console.error)
