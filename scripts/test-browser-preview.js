const { chromium } = require('playwright');
const http = require('http');

const PROJECT_ID = 'prj_ms8re9qotmnr4ig7';
const PREVIEW_URL = `http://localhost:3000/preview/${PROJECT_ID}?previewToken=valid`;

function probePort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, { timeout: 1000 }, (res) => {
      resolve({ status: res.statusCode });
      res.resume();
    });
    req.on('error', (err) => resolve({ error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'timeout' });
    });
  });
}

async function run() {
  console.log('=== TAHAP 3: REAL PLAYWRIGHT BROWSER VERIFICATION ===');
  console.log('Project ID:', PROJECT_ID);
  console.log('Preview Gateway URL:', PREVIEW_URL);

  // 1. Check runtime port
  const port4930 = await probePort(4930);
  const port4688 = await probePort(4688);
  console.log('Upstream Port 4930 Probe:', port4930);
  console.log('Upstream Port 4688 Probe:', port4688);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleLogs = [];
  const pageErrors = [];
  const failedRequests = [];
  const successfulRequests = [];
  const jsModules = [];
  const cssAssets = [];
  let blobNullDetected = false;

  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('blob:null')) {
      blobNullDetected = true;
    }
    consoleLogs.push({ type: msg.type(), text });
  });

  page.on('pageerror', (err) => {
    const text = err.message + '\n' + (err.stack || '');
    if (text.includes('blob:null')) {
      blobNullDetected = true;
    }
    pageErrors.push(text);
  });

  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('blob:null')) {
      blobNullDetected = true;
    }
  });

  page.on('requestfailed', (req) => {
    failedRequests.push({ url: req.url(), failure: req.failure()?.errorText });
  });

  page.on('response', (res) => {
    const url = res.url();
    const status = res.status();
    const contentType = res.headers()['content-type'] || '';
    if (status < 400) {
      successfulRequests.push({ url, status, contentType });
    }
    if (url.includes('.js') || contentType.includes('javascript')) {
      jsModules.push({ url, status, ok: res.ok() });
    }
    if (url.includes('.css') || contentType.includes('text/css')) {
      cssAssets.push({ url, status, ok: res.ok() });
    }
  });

  console.log('\n[1/4] Navigating to preview gateway in Chromium...');
  const response = await page.goto(PREVIEW_URL, {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  console.log('Main navigation response status:', response?.status());

  // Wait 3 seconds for client hydration and script execution
  await page.waitForTimeout(3000);

  // Check hydration and DOM
  const title = await page.title();
  const bodyText = (await page.evaluate(() => document.body.innerText)).trim();
  const nextRootExists = await page.evaluate(() => {
    return Boolean(
      document.querySelector('#__next') ||
      document.querySelector('body > div') ||
      document.querySelector('main')
    );
  });

  console.log('\n[2/4] Page State:');
  console.log('Page Title:', title);
  console.log('Page Body Text:\n"' + bodyText + '"');
  console.log('Next.js/React DOM Root present:', nextRootExists);

  console.log('\n[3/4] Assets & Modules Execution:');
  console.log('JavaScript modules loaded:', jsModules.length);
  jsModules.forEach((m) => console.log(`  - [${m.status}] ${m.url}`));
  console.log('CSS stylesheets loaded:', cssAssets.length);
  cssAssets.forEach((c) => console.log(`  - [${c.status}] ${c.url}`));
  console.log('blob:null/<uuid> detected anywhere:', blobNullDetected);
  console.log('Console errors count:', consoleLogs.filter((l) => l.type === 'error').length);
  console.log('Page unhandled errors count:', pageErrors.length);
  console.log('Failed network requests count:', failedRequests.length);

  // [4/4] Test Reload / Refresh authorization
  console.log('\n[4/4] Testing Reload / Re-navigation (cookie & auth check)...');
  const reloadResponse = await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
  console.log('Reload response status:', reloadResponse?.status());

  // Final summary checks
  const pass =
    response?.status() === 200 &&
    reloadResponse?.status() === 200 &&
    !blobNullDetected &&
    pageErrors.length === 0 &&
    failedRequests.length === 0 &&
    jsModules.length > 0 &&
    jsModules.every((m) => m.status === 200) &&
    cssAssets.length > 0 &&
    cssAssets.every((c) => c.status === 200);

  console.log('\n=== TAHAP 3 VERIFICATION RESULT ===');
  console.log('Overall Status:', pass ? 'PASS' : 'FAIL');

  await browser.close();

  if (!pass) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
