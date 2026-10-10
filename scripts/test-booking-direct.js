const { chromium } = require('playwright');
const fs = require('fs');
const { createClerkClient } = require('@clerk/nextjs/server');

const PROJECT_ID = 'prj_ms8re9qotmnr4ig7';
const BASE_URL = 'http://localhost:3000';

let secretKey = '';
if (fs.existsSync('.env.local')) {
  const match = fs.readFileSync('.env.local', 'utf8').match(/CLERK_SECRET_KEY=([^\r\n]+)/);
  if (match) secretKey = match[1].trim();
}
const client = createClerkClient({ secretKey });

async function testBookingDirect() {
  const token = await client.signInTokens.createSignInToken({
    userId: 'user_3EbkqajCnaFbBhUenaejazvdOYp',
    expiresInSeconds: 300,
  });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', msg => console.log('[PAGE CONSOLE]', msg.type(), msg.text()));
  page.on('pageerror', err => console.error('[PAGE ERROR]', err.message));

  // Navigate to login
  await page.goto(token.url + '&redirect_url=' + encodeURIComponent(`${BASE_URL}/api/preview/${PROJECT_ID}/booking`));
  await page.waitForLoadState('networkidle');

  console.log('Direct booking URL loaded:', page.url());
  const h1 = await page.locator('h1').textContent();
  console.log('Direct Booking H1:', h1);

  // Check input values
  await page.locator('input[name="name"]').fill('Budi');
  await page.locator('input[name="phone"]').fill('08123456789');
  await page.locator('input[name="address"]').fill('Jl Sudirman');
  await page.locator('select[name="service"]').selectOption('express');
  await page.locator('input[name="weight"]').fill('2');
  await page.locator('input[name="dateTime"]').fill('2026-10-12T10:00');

  // Listen to dialogs (alert)
  page.on('dialog', async dialog => {
    console.log('[ALERT DIALOG DETECTED]:', dialog.message());
    await dialog.accept();
  });

  console.log('Submitting form...');
  await page.locator('button[type="submit"]').click();

  // Wait 3 seconds
  await page.waitForTimeout(3000);
  const bodyText = await page.textContent('body');
  console.log('Has success text:', bodyText.includes('Pesanan Anda Berhasil Dikirim!'));

  await browser.close();
}

testBookingDirect().catch(console.error);
