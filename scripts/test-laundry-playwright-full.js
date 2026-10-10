const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PROJECT_ID = 'prj_ms8re9qotmnr4ig7';
const BASE_URL = 'http://localhost:3000';

async function main() {
  console.log('Starting Laundry Ku Full Playwright Verification...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  const networkFailures = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  page.on('pageerror', (err) => {
    consoleErrors.push(err.message);
  });

  page.on('requestfailed', (req) => {
    networkFailures.push({ url: req.url(), error: req.failure()?.errorText });
  });

  // 1. Visit Home Page through Gateway
  console.log('\n--- 1. Testing Home Page Render ---');
  const homeUrl = `${BASE_URL}/preview/${PROJECT_ID}?previewToken=valid`;
  const homeResp = await page.goto(homeUrl, { waitUntil: 'networkidle', timeout: 30000 });
  console.log('Home Status:', homeResp.status());

  await page.waitForTimeout(2000);

  const homeTitle = await page.title();
  console.log('Home Title:', homeTitle);

  const heroHeading = await page.locator('h1').textContent();
  console.log('Hero Heading:', heroHeading);

  const navBrand = await page.locator('nav a').first().textContent();
  console.log('Nav Brand:', navBrand);

  const featureCards = await page.locator('#features article h3').allTextContents();
  console.log('Features found:', featureCards);

  // Take screenshot of Home
  const screenshotsDir = path.resolve(process.cwd(), 'playwright-screenshots');
  if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
  const homeScreenshot = path.join(screenshotsDir, 'laundry-home.png');
  await page.screenshot({ path: homeScreenshot, fullPage: true });
  console.log('Saved Home screenshot to:', homeScreenshot);

  // 2. Click CTA "Pesan Sekarang" or navigate to /booking
  console.log('\n--- 2. Testing Booking Page Form ---');
  const bookingUrl = `${BASE_URL}/preview/${PROJECT_ID}/booking?previewToken=valid`;
  const bookingResp = await page.goto(bookingUrl, { waitUntil: 'networkidle', timeout: 30000 });
  console.log('Booking Status:', bookingResp.status());

  await page.waitForTimeout(2000);

  const bookingHeading = await page.locator('h1').textContent();
  console.log('Booking Heading:', bookingHeading);

  // Fill in booking form
  await page.fill('input[name="name"]', 'Budi Santoso');
  await page.fill('input[name="phone"]', '081234567890');
  await page.fill('input[name="address"]', 'Jl. Merdeka No. 45, Jakarta');
  await page.selectOption('select[name="service"]', 'kiloan');
  await page.fill('input[name="weight"]', '5');
  await page.fill('input[name="dateTime"]', '2026-10-15T10:00');
  await page.fill('textarea[name="notes"]', 'Tolong pisahkan pakaian putih');

  const bookingScreenshot = path.join(screenshotsDir, 'laundry-booking-filled.png');
  await page.screenshot({ path: bookingScreenshot, fullPage: true });
  console.log('Saved Booking form filled screenshot to:', bookingScreenshot);

  // Submit the form
  console.log('Submitting booking form...');
  await page.click('button[type="submit"]');

  // Wait for submission success state
  await page.waitForSelector('text=Pesanan Anda Berhasil Dikirim!', { timeout: 10000 });
  const successText = await page.locator('h2').textContent();
  console.log('Success state text:', successText);

  const successScreenshot = path.join(screenshotsDir, 'laundry-booking-success.png');
  await page.screenshot({ path: successScreenshot, fullPage: true });
  console.log('Saved Booking success screenshot to:', successScreenshot);

  // Return to home via link
  await page.click('text=Kembali ke Beranda');
  await page.waitForTimeout(2000);
  console.log('Returned to Home URL:', page.url());

  await browser.close();

  console.log('\n--- SUMMARY ---');
  console.log('Console Errors:', consoleErrors.length, consoleErrors);
  console.log('Network Failures:', networkFailures.length, networkFailures);

  if (consoleErrors.length > 0 || networkFailures.length > 0) {
    console.error('FAILED: There were console errors or network failures');
    process.exit(1);
  }

  console.log('ALL LAUNDRY KU PLAYWRIGHT TESTS PASSED WITH 0 ERRORS!');
}

main().catch((err) => {
  console.error('Fatal Playwright Error:', err);
  process.exit(1);
});
