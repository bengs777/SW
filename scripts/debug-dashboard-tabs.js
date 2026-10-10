const fs = require('fs');
let secretKey = '';
if (fs.existsSync('.env.local')) {
  const match = fs.readFileSync('.env.local', 'utf8').match(/CLERK_SECRET_KEY=([^\r\n]+)/);
  if (match) secretKey = match[1].trim();
}
const { createClerkClient } = require('@clerk/nextjs/server');
const { chromium } = require('playwright');
const client = createClerkClient({ secretKey });

async function check() {
  const token = await client.signInTokens.createSignInToken({
    userId: 'user_3EbkqajCnaFbBhUenaejazvdOYp',
    expiresInSeconds: 300,
  });
  const urlWithRedirect = token.url + '&redirect_url=' + encodeURIComponent('http://localhost:3000/dashboard/project/prj_ms8re9qotmnr4ig7');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  page.on('console', m => console.log('LOG:', m.text()));

  await page.goto(urlWithRedirect, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Look for Tabs in PreviewPanel
  const tabButtons = await page.locator('[role="tab"]').all();
  console.log('Total tab triggers found:', tabButtons.length);
  for (const b of tabButtons) {
    const text = await b.textContent();
    const val = await b.getAttribute('data-value') || await b.getAttribute('value');
    console.log('  Tab:', text, 'val:', val);
  }

  // Find Preview tab specifically
  const previewTab = page.locator('button:has-text("Preview")');
  console.log('Preview button matches:', await previewTab.count());
  for (let i = 0; i < await previewTab.count(); i++) {
    const el = previewTab.nth(i);
    console.log(`  Preview button ${i}:`, await el.getAttribute('role'), await el.evaluate(e => e.outerHTML.slice(0, 100)));
  }

  // Click the Preview tab button inside PreviewPanel
  const targetTab = page.locator('[role="tab"]:has-text("Preview")');
  if (await targetTab.count() > 0) {
    await targetTab.first().click();
    console.log('Clicked targetTab!');
    await page.waitForTimeout(4000);

    const iframes = await page.locator('iframe').all();
    console.log('Iframes after click:', iframes.length);

    const frame = page.frame({ url: /preview/ });
    console.log('Frame initial URL:', frame ? frame.url() : 'no frame');

    if (frame) {
      const cta = frame.locator('a[href="/booking"]').first();
      console.log('CTA text:', await cta.textContent());
      console.log('CTA href attribute:', await cta.getAttribute('href'));
      await cta.click();
      await page.waitForTimeout(3000);
      console.log('Frame URL after click:', frame.url());
      const allFrames = page.frames().map(f => f.url());
      console.log('All frames URLs:', allFrames);
    }
  }

  await browser.close();
}
check().catch(console.error);
