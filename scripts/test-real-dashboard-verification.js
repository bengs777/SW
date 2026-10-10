const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { createClerkClient } = require('@clerk/nextjs/server');

const PROJECT_ID = 'prj_ms8re9qotmnr4ig7';
const BASE_URL = 'http://localhost:3000';

let secretKey = '';
if (fs.existsSync('.env.local')) {
  const match = fs.readFileSync('.env.local', 'utf8').match(/CLERK_SECRET_KEY=([^\r\n]+)/);
  if (match) secretKey = match[1].trim();
}
const client = createClerkClient({ secretKey });

async function main() {
  console.log('===============================================================');
  console.log('  TESTING REAL DASHBOARD PREVIEW INTEGRATION VIA PLAYWRIGHT    ');
  console.log('===============================================================');

  // Step 1: Create Clerk session
  console.log('\n[1/5] Authenticating owner user via Clerk API...');
  const token = await client.signInTokens.createSignInToken({
    userId: 'user_3EbkqajCnaFbBhUenaejazvdOYp',
    expiresInSeconds: 300,
  });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleLogs = [];
  const pageErrors = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.log('[PAGE CONSOLE ERROR]', msg.text());
      consoleLogs.push(msg.text());
    }
  });
  page.on('requestfailed', (req) => {
    console.log('[REQ FAILED]', req.url(), req.failure()?.errorText);
  });
  page.on('dialog', async (d) => {
    console.log('[DIALOG DETECTED]', d.type(), d.message());
    await d.accept();
  });

  // Navigate to login and consume ticket with direct redirect to dashboard
  const urlWithRedirect = token.url + '&redirect_url=' + encodeURIComponent(`${BASE_URL}/dashboard/project/${PROJECT_ID}`);
  const resp = await page.goto(urlWithRedirect, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForURL(`**/${PROJECT_ID}*`, { timeout: 30000 });
  console.log('Dashboard Navigation Status:', resp.status());
  console.log('Current Dashboard URL:', page.url());

  if (page.url().includes('/login')) {
    throw new Error('Authentication failed: redirected to /login');
  }

  // Ensure Preview tab is selected
  const previewTabTrigger = page.locator('[role="tab"]:has-text("Preview")');
  if (await previewTabTrigger.count() > 0) {
    console.log('Clicking Preview tab trigger in PreviewPanel...');
    await previewTabTrigger.first().click();
  }

  // Wait for dashboard editor UI and preview iframe to mount
  await page.waitForSelector('iframe[title="Runtime preview"]', { timeout: 20000 });
  console.log('Preview iframe located in dashboard.');

  await page.waitForFunction(() => {
    const el = document.querySelector('iframe[title="Runtime preview"]');
    return el && el.getAttribute('src') && !el.getAttribute('src').startsWith('about:blank');
  }, { timeout: 20000 });

  const frameHandle = await page.$('iframe[title="Runtime preview"]');
  const frame = await frameHandle.contentFrame();

  // Wait for preview content inside iframe
  await frame.waitForSelector('h1', { timeout: 30000 });
  const iframeH1 = await frame.$eval('h1', el => el.textContent);
  console.log('H1 inside Dashboard Preview iframe:', iframeH1);

  const screenshotsDir = path.resolve(process.cwd(), 'playwright-screenshots');
  if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

  const initialDashScreenshot = path.join(screenshotsDir, 'dashboard-preview-initial.png');
  await page.screenshot({ path: initialDashScreenshot });
  console.log('Saved dashboard preview screenshot to:', initialDashScreenshot);

  // Step 3: Test Preview Reload inside dashboard
  console.log('\n[3/5] Testing Preview Refresh inside dashboard...');
  // Click refresh preview button in PreviewPanel
  const refreshBtn = page.locator('button[title="Refresh preview"]');
  if (await refreshBtn.isVisible()) {
    await refreshBtn.click();
    console.log('Clicked "Refresh preview" button.');
  } else {
    console.log('Refresh button not visible, testing page reload...');
    await page.reload({ waitUntil: 'domcontentloaded' });
  }

  await page.waitForTimeout(3000);
  const refreshedFrame = await (await page.$('iframe[title="Runtime preview"]')).contentFrame();
  await refreshedFrame.waitForSelector('h1', { timeout: 30000 });
  const reloadedIframeH1 = await refreshedFrame.$eval('h1', el => el.textContent);
  console.log('H1 inside Dashboard Preview iframe after refresh:', reloadedIframeH1);

  // Also test full page reload of the dashboard
  console.log('Testing full dashboard page reload...');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  const previewTabTrigger2 = page.locator('[role="tab"]:has-text("Preview")');
  if (await previewTabTrigger2.count() > 0) {
    await previewTabTrigger2.first().click();
  }
  await page.waitForSelector('iframe[title="Runtime preview"]', { timeout: 20000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('iframe[title="Runtime preview"]');
    return el && el.getAttribute('src') && !el.getAttribute('src').startsWith('about:blank');
  }, { timeout: 20000 });
  const frameHandle2 = await page.$('iframe[title="Runtime preview"]');
  const frame2 = await frameHandle2.contentFrame();
  await frame2.waitForSelector('h1', { timeout: 30000 });
  const fullReloadH1 = await frame2.$eval('h1', el => el.textContent);
  console.log('H1 inside Dashboard Preview iframe after full page reload:', fullReloadH1);

  const reloadDashScreenshot = path.join(screenshotsDir, 'dashboard-preview-after-reload.png');
  await page.screenshot({ path: reloadDashScreenshot });
  console.log('Saved after-reload screenshot to:', reloadDashScreenshot);

  // Step 4: Test Navigation to /booking inside Preview iframe
  console.log('\n[4/5] Testing navigation to /booking inside iframe...');
  console.log('Initial Preview Frame URL:', frame2.url());

  const ctaBtn = frame2.locator('a:has-text("Pesan Sekarang")').first();
  await ctaBtn.scrollIntoViewIfNeeded();
  console.log('Clicking "Pesan Sekarang" CTA button...');
  await ctaBtn.click();

  console.log('Waiting for "Formulir Pesanan Laundry" heading inside iframe...');
  await frame2.waitForSelector('h1:has-text("Formulir Pesanan Laundry")', { timeout: 30000 });
  const bookingH1 = await frame2.$eval('h1:has-text("Formulir Pesanan Laundry")', el => el.textContent);
  console.log('H1 inside iframe on booking page:', bookingH1);
  console.log('Current Preview Frame URL after navigation:', frame2.url());

  const bookingIframeScreenshot = path.join(screenshotsDir, 'dashboard-preview-booking.png');
  await page.screenshot({ path: bookingIframeScreenshot });
  console.log('Saved booking iframe screenshot to:', bookingIframeScreenshot);

  page.on('dialog', async (d) => {
    console.log('[DIALOG DETECTED]', d.type(), d.message());
    await d.accept();
  });

  // Step 5: Test returning to Home inside iframe
  console.log('\n[5/5] Testing booking form submission and return to Home inside iframe...');
  console.log('Waiting 3s for client hydration to settle...');
  await page.waitForTimeout(3000);

  // Fill booking form and submit to test form flow inside dashboard
  await frame2.locator('input[name="name"]').fill('Siti Rahma');
  await frame2.locator('input[name="phone"]').fill('081987654321');
  await frame2.locator('input[name="address"]').fill('Jl. Kebon Jeruk No. 12');
  await frame2.locator('select[name="service"]').selectOption('express');
  await frame2.locator('input[name="weight"]').fill('3');
  await frame2.locator('input[name="dateTime"]').fill('2026-10-12T14:00');
  
  console.log('Submitting booking form inside iframe...');
  const submitBtn = frame2.locator('button[type="submit"]');
  await submitBtn.scrollIntoViewIfNeeded();
  await submitBtn.click();

  console.log('Waiting for "Pesanan Anda Berhasil Dikirim!" confirmation...');
  await frame2.waitForSelector('text=Pesanan Anda Berhasil Dikirim!', { timeout: 15000 });
  console.log('Booking submitted successfully inside dashboard preview.');

  // Click "Kembali ke Beranda"
  await frame2.locator('text=Kembali ke Beranda').click();
  await frame2.waitForSelector('h1:has-text("Laundry Ku")', { timeout: 15000 });
  const returnedH1 = await frame2.$eval('h1', el => el.textContent);
  console.log('H1 after returning to Home:', returnedH1);

  const finalDashScreenshot = path.join(screenshotsDir, 'dashboard-preview-returned-home.png');
  await page.screenshot({ path: finalDashScreenshot });
  console.log('Saved final dashboard screenshot to:', finalDashScreenshot);

  await browser.close();

  console.log('\n--- VERIFICATION RESULT ---');
  console.log('Console Errors (critical):', consoleLogs.length);
  console.log('Page Errors:', pageErrors.length);

  const pass =
    iframeH1.includes('Laundry Ku') &&
    fullReloadH1.includes('Laundry Ku') &&
    bookingH1.includes('Formulir Pesanan Laundry') &&
    returnedH1.includes('Laundry Ku');

  console.log('Dashboard Real E2E Status:', pass ? 'PASS' : 'FAIL');
  if (!pass) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
