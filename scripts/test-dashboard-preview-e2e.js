const { chromium } = require('playwright');
const http = require('http');

const PROJECT_ID = 'prj_ms8re9qotmnr4ig7';
const BASE_URL = 'http://localhost:3000';

function probe(options) {
  return new Promise((resolve) => {
    const req = http.request(options, (res) => {
      resolve({ status: res.statusCode, headers: res.headers });
      res.resume();
    });
    req.on('error', (err) => resolve({ error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'timeout' });
    });
    req.end();
  });
}

async function run() {
  console.log('===============================================================');
  console.log('  SWIFT PREVIEW RUNTIME & DASHBOARD INTEGRATION TEST (REAL E2E) ');
  console.log('===============================================================');

  // STEP 1: Test Unauthenticated Dashboard Access
  console.log('\n[TEST 1] Verifying unauthenticated dashboard access...');
  const dashRes = await probe({
    hostname: '127.0.0.1',
    port: 3000,
    path: `/dashboard/project/${PROJECT_ID}`,
    method: 'GET',
  });
  console.log('  -> Dashboard Unauth Status:', dashRes.status);
  console.log('  -> Redirect Location:', dashRes.headers?.location);
  const pass1 = dashRes.status === 307 && dashRes.headers?.location?.includes('/login');
  console.log('  -> RESULT:', pass1 ? 'PASS (Properly redirected to /login)' : 'FAIL');

  // STEP 2: Test Unauthenticated Gateway Access
  console.log('\n[TEST 2] Verifying unauthenticated Preview Gateway access...');
  const gwUnauthRes = await probe({
    hostname: '127.0.0.1',
    port: 3000,
    path: `/preview/${PROJECT_ID}`,
    method: 'GET',
  });
  console.log('  -> Gateway Unauth Status:', gwUnauthRes.status);
  const pass2 = gwUnauthRes.status === 401;
  console.log('  -> RESULT:', pass2 ? 'PASS (Direct access rejected with 401)' : 'FAIL');

  // STEP 3: Test Forged Referer Access
  console.log('\n[TEST 3] Verifying forged Referer access rejection...');
  const gwForgedRes = await probe({
    hostname: '127.0.0.1',
    port: 3000,
    path: `/preview/${PROJECT_ID}`,
    method: 'GET',
    headers: { Referer: `http://localhost:3000/preview/${PROJECT_ID}` },
  });
  console.log('  -> Forged Referer Status:', gwForgedRes.status);
  const pass3 = gwForgedRes.status === 401;
  console.log('  -> RESULT:', pass3 ? 'PASS (Forged Referer rejected with 401)' : 'FAIL');

  // STEP 4: Test Cross-Project Cookie Isolation
  console.log('\n[TEST 4] Verifying cross-project cookie isolation...');
  const gwCrossRes = await probe({
    hostname: '127.0.0.1',
    port: 3000,
    path: `/preview/prj_other_isolated_99`,
    method: 'GET',
    headers: { Cookie: `swift_preview_${PROJECT_ID}=valid` },
  });
  console.log('  -> Cross-Project Access Status:', gwCrossRes.status);
  const pass4 = gwCrossRes.status === 401;
  console.log('  -> RESULT:', pass4 ? 'PASS (Project isolation strictly enforced)' : 'FAIL');

  // STEP 5: Upstream Port Probing & Ownership Verification
  console.log('\n[TEST 5] Verifying upstream sandbox runtime ports...');
  const port4930 = await probe({ hostname: '127.0.0.1', port: 4930, path: '/', method: 'GET' });
  const port4688 = await probe({ hostname: '127.0.0.1', port: 4688, path: '/', method: 'GET' });
  console.log('  -> Port 4930 (usr_ms8rdt5x7453pgq6-prj_ms8re9qotmnr4ig7):', port4930.status || port4930.error);
  console.log('  -> Port 4688 (prj_ms8re9qotmnr4ig7 sandbox-runtime):', port4688.status || port4688.error);
  const pass5 = port4930.status === 200 || port4688.status === 200;
  console.log('  -> RESULT:', pass5 ? 'PASS (Upstream Next.js runtime alive)' : 'FAIL');

  // STEP 6: Real Chromium Browser Execution (Gateway Iframe)
  console.log('\n[TEST 6] Running real Playwright browser against Preview Gateway...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleLogs = [];
  const pageErrors = [];
  const failedRequests = [];
  const jsModules = [];
  const cssAssets = [];
  let blobNullDetected = false;

  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('blob:null')) blobNullDetected = true;
    consoleLogs.push({ type: msg.type(), text });
  });

  page.on('pageerror', (err) => {
    const text = err.message + '\n' + (err.stack || '');
    if (text.includes('blob:null')) blobNullDetected = true;
    pageErrors.push(text);
  });

  page.on('request', (req) => {
    if (req.url().includes('blob:null')) blobNullDetected = true;
  });

  page.on('requestfailed', (req) => {
    failedRequests.push({ url: req.url(), failure: req.failure()?.errorText });
  });

  page.on('response', (res) => {
    const url = res.url();
    const status = res.status();
    const contentType = res.headers()['content-type'] || '';
    if (url.includes('.js') || contentType.includes('javascript')) {
      jsModules.push({ url, status });
    }
    if (url.includes('.css') || contentType.includes('text/css')) {
      cssAssets.push({ url, status });
    }
  });

  const previewTargetUrl = `${BASE_URL}/preview/${PROJECT_ID}?previewToken=valid`;
  const navResponse = await page.goto(previewTargetUrl, {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  console.log('  -> Initial Gateway Navigation Status:', navResponse?.status());

  // Wait 3 seconds for client hydration
  await page.waitForTimeout(3000);

  const pageTitle = await page.title();
  const bodyText = (await page.evaluate(() => document.body.innerText)).trim();
  const nextAppRoot = await page.evaluate(() => {
    return Boolean(
      document.querySelector('#_R_') ||
      document.querySelector('script[src*="15xrurgzs99gv.js"]') ||
      document.querySelector('main')
    );
  });

  console.log('  -> Page Title:', pageTitle);
  console.log('  -> Page Body Content:\n"' + bodyText.slice(0, 200) + '"');
  console.log('  -> Next.js App Root Present:', nextAppRoot);
  console.log('  -> JS Modules Loaded:', jsModules.length, '(All 200 OK:', jsModules.every((m) => m.status === 200), ')');
  console.log('  -> CSS Assets Loaded:', cssAssets.length, '(All 200 OK:', cssAssets.every((c) => c.status === 200), ')');
  console.log('  -> blob:null/<uuid> Detected:', blobNullDetected);
  console.log('  -> Console Errors:', consoleLogs.filter((l) => l.type === 'error').length);
  console.log('  -> Unhandled Page Errors:', pageErrors.length);
  console.log('  -> Failed Requests:', failedRequests.length);

  // STEP 7: Browser Reload & 304 Handling Test
  console.log('\n[TEST 7] Testing Browser Reload (304 Not Modified & Cookie persistence)...');
  const reloadResponse = await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
  console.log('  -> Reload Navigation Status:', reloadResponse?.status());
  const pass7 = reloadResponse?.status() === 200;
  console.log('  -> RESULT:', pass7 ? 'PASS (Reload 200 OK, 304 handled without crash)' : 'FAIL');

  await browser.close();

  const allPassed =
    pass1 &&
    pass2 &&
    pass3 &&
    pass4 &&
    pass5 &&
    navResponse?.status() === 200 &&
    !blobNullDetected &&
    pageErrors.length === 0 &&
    failedRequests.length === 0 &&
    jsModules.length > 0 &&
    jsModules.every((m) => m.status === 200) &&
    cssAssets.length > 0 &&
    cssAssets.every((c) => c.status === 200) &&
    pass7;

  console.log('\n===============================================================');
  console.log('FINAL PREVIEW RUNTIME STATUS:', allPassed ? 'PASS' : 'FAIL');
  console.log('===============================================================');

  if (!allPassed) process.exit(1);
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
