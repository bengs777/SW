# PHASE 3: SMOKE TESTING - Manual Browser Testing Checklist
## Complete End-to-End Generation Verification

**Timeline**: 1.5-2 hours  
**Prerequisites**: Phase 1 & 2 completed successfully  
**Method**: Manual UI testing in browser  
**Success**: All items pass

---

## SMOKE TESTING OVERVIEW

This phase validates the complete generation pipeline:
1. **Login & Dashboard Access** (15 min)
2. **Create New Project** (10 min)
3. **Submit Generation Request** (10 min)
4. **Monitor Generation Pipeline** (30-45 min)
5. **Verify Code Output Quality** (20 min)
6. **Test Preview & Deployment** (20 min)

Total: 1.5-2 hours

---

## TEST ENVIRONMENT

- **URL**: https://www.ai-swift.biz.id
- **Browser**: Chrome, Safari, or Firefox
- **Network**: Good internet connection (generation takes time)
- **Test Account**: You'll use your authenticated account

---

## SECTION 1: LOGIN & DASHBOARD ACCESS (15 minutes)

### Test 1.1: Access login page
- [ ] Open https://www.ai-swift.biz.id in browser
- [ ] Should see login form
- [ ] Form has "Email" and "Password" fields
- [ ] Form has "Login" button
- [ ] Page loads quickly (< 3 seconds)

### Test 1.2: Sign up if needed
- [ ] Click "Sign Up" link
- [ ] Fill in email and password
- [ ] Click "Create account"
- [ ] Should get confirmation message
- [ ] Redirected to login page
- [ ] **Note**: If you already have account, skip to Test 1.3

### Test 1.3: Log in to account
- [ ] Enter your email
- [ ] Enter your password
- [ ] Click "Login"
- [ ] Should redirect to dashboard
- [ ] No error messages
- [ ] Page loads quickly (< 2 seconds)

### Test 1.4: Verify dashboard loads
- [ ] You're now on dashboard
- [ ] Can see left sidebar with navigation
- [ ] Can see main content area
- [ ] Can see "Projects" section
- [ ] No error banners at top
- [ ] All pages responsive on desktop

### Test 1.5: Check navigation
- [ ] Click "Dashboard" → loads quickly
- [ ] Click "Projects" → shows project list
- [ ] Click "Templates" → shows available templates
- [ ] Click "Admin" → accessible (if admin)
- [ ] Click "Settings" → loads settings page
- [ ] All navigation works without errors

**Completion Check 1.5**: ✅ Login and dashboard verified

---

## SECTION 2: CREATE NEW PROJECT (10 minutes)

### Test 2.1: Start new project
- [ ] On Projects page
- [ ] Click "Create New Project" or similar button
- [ ] Modal or form appears
- [ ] Form asks for project name
- [ ] Form asks for template selection

### Test 2.2: Select template
- [ ] See list of templates (E-commerce, Blog, Dashboard, etc.)
- [ ] Select "E-commerce" template (most complete for testing)
- [ ] Template preview shows
- [ ] Click "Next" or "Create"

### Test 2.3: Configure project
- [ ] Enter project name: "Smoke Test E-commerce"
- [ ] If asked for description, enter: "Testing generation pipeline"
- [ ] Select language (if asked): Keep default
- [ ] Click "Create Project"
- [ ] Wait for project to initialize (10-15 seconds)

### Test 2.4: Verify project created
- [ ] Project appears in Projects list
- [ ] Project has status "Draft"
- [ ] Can see project card with template info
- [ ] Click on project to open it

**Completion Check 2.4**: ✅ Project created and accessible

---

## SECTION 3: SUBMIT GENERATION REQUEST (10 minutes)

### Test 3.1: Access prompt editor
- [ ] Inside project, see "AI Builder" section
- [ ] Can see "Prompt" input field
- [ ] Field says "Ready for first prompt"
- [ ] Have text editor for writing prompt

### Test 3.2: Write generation prompt
- [ ] Clear any existing text
- [ ] Enter this test prompt:

```
Create a modern e-commerce dashboard with:
- Product inventory table with search and filters
- Sales analytics with charts showing daily revenue
- Order management with status tracking
- User profile cards showing top customers
- Dark mode toggle in header
Use a professional blue color scheme.
```

- [ ] Prompt appears in editor
- [ ] No syntax errors highlighted

### Test 3.3: Submit generation job
- [ ] Click "Generate" or "Submit" button
- [ ] Should see "Generating..." message
- [ ] Button becomes disabled (grayed out)
- [ ] Job status shows "In Progress"
- [ ] Progress indicator appears

### Test 3.4: Monitor initial response
- [ ] Wait 5-10 seconds
- [ ] Should see "Planning" stage start
- [ ] Progress bar updates
- [ ] No error messages
- [ ] Job ID visible (for reference)

**Completion Check 3.4**: ✅ Generation request submitted

---

## SECTION 4: MONITOR GENERATION PIPELINE (30-45 minutes)

This section monitors the multi-stage generation process.

### Test 4.1: Watch planning stage
- [ ] Wait 5-10 seconds
- [ ] "Planning" stage should show "Started"
- [ ] System generating architecture plan
- [ ] No error messages
- [ ] Elapsed time shows progress

### Test 4.2: Watch validation stages
- [ ] After planning, "Validating" stage appears
- [ ] Multiple validation checkmarks show up:
  - [ ] Scaffold validation
  - [ ] Configuration validation
  - [ ] Architecture validation
  - [ ] Baseline validation
  - [ ] Final validation
- [ ] All stages should show "passed"
- [ ] No red X marks (failures)

### Test 4.3: Watch generation stage
- [ ] After validation, "Generating" stage starts
- [ ] System generates code artifacts
- [ ] Progress indicator shows generation in progress
- [ ] Takes 10-30 minutes (depends on AI provider)
- [ ] No timeouts or disconnections

### Test 4.4: Monitor for errors
- [ ] **IMPORTANT**: Watch for error messages
- [ ] No "Generation failed" messages
- [ ] No "Timeout" errors
- [ ] No "Queue error" messages
- [ ] No "Worker crashed" messages
- [ ] If error occurs, note the exact error message

### Test 4.5: Check diagnostics panel
- [ ] On right side, click "Diagnostics" tab
- [ ] Shows execution timeline with stages
- [ ] Shows worker status
- [ ] Shows trace ID for debugging
- [ ] No "FAILED" indicators
- [ ] Planner confidence shows (e.g., "0.85")

### Test 4.6: Wait for completion
- [ ] Generation stage completes (takes 10-30 min)
- [ ] All stages show as completed
- [ ] Progress bar shows 100%
- [ ] Job status changes to "Completed" or "Ready"
- [ ] No error banners at top of page

**Completion Check 4.6**: ✅ Generation pipeline completed successfully

---

## SECTION 5: VERIFY CODE OUTPUT QUALITY (20 minutes)

### Test 5.1: Access generated code
- [ ] Generation completed
- [ ] See "Preview" button or tab
- [ ] Click "Preview" or "View Code"
- [ ] Code editor opens showing generated files

### Test 5.2: Verify file structure
- [ ] Should see multiple files/folders:
  - [ ] `app/page.tsx` (main page)
  - [ ] `app/layout.tsx` (root layout)
  - [ ] `app/components/` folder (components)
  - [ ] `tailwind.config.ts` (styling)
  - [ ] `package.json` (dependencies)
  - [ ] Other config files

### Test 5.3: Check code quality
- [ ] Open `app/page.tsx`
- [ ] Should contain real TSX code (not skeleton/scaffold)
- [ ] Should have proper React components
- [ ] Should have Tailwind CSS classes
- [ ] Code matches the prompt (e-commerce dashboard elements)

### Test 5.4: Verify component implementation
- [ ] See actual component implementations
- [ ] Components have proper props and state
- [ ] Has real data handling (not placeholder)
- [ ] Contains tables, charts, or other features requested
- [ ] **NOT just a scaffold/template**

### Test 5.5: Check dependencies
- [ ] Open `package.json`
- [ ] Should see necessary dependencies like:
  - [ ] `next` (framework)
  - [ ] `react` (UI library)
  - [ ] `tailwindcss` (styling)
  - [ ] `recharts` (if charts were requested)
- [ ] No unexpected or broken dependencies

### Test 5.6: Validate TypeScript
- [ ] Open TypeScript files (`.tsx`)
- [ ] Should have type annotations
- [ ] Should have proper imports
- [ ] No obvious TypeScript errors
- [ ] Code is syntactically valid

**Completion Check 5.6**: ✅ Code output is real and high-quality

---

## SECTION 6: TEST PREVIEW & DEPLOYMENT (20 minutes)

### Test 6.1: View live preview
- [ ] In project, click "Preview" tab or button
- [ ] Preview window opens showing generated app
- [ ] App loads and displays content
- [ ] Should show the dashboard from prompt
  - [ ] Inventory table visible
  - [ ] Charts visible
  - [ ] Order status visible
  - [ ] User profiles visible
  - [ ] Dark mode toggle visible

### Test 6.2: Test preview interactivity
- [ ] Try clicking buttons in preview
- [ ] Try interacting with table (sort, filter)
- [ ] Toggle dark mode (if available)
- [ ] Try scrolling page
- [ ] All interactions work smoothly
- [ ] No JavaScript errors in console

### Test 6.3: Check responsive design
- [ ] Resize preview window
- [ ] Reduce width to simulate mobile
- [ ] App should remain functional (responsive)
- [ ] No overlapping elements
- [ ] Text remains readable
- [ ] Buttons remain clickable

### Test 6.4: Check deployment readiness
- [ ] See "Deploy" button or option
- [ ] Project shows status "Ready for deployment"
- [ ] No blocking errors
- [ ] GitHub integration shows (if configured)

### Test 6.5: Verify logs and diagnostics
- [ ] Click "Logs" tab
- [ ] Should see log entries from generation
- [ ] No ERROR level logs
- [ ] See INFO level logs showing progress
- [ ] Trace ID present for debugging

**Completion Check 6.5**: ✅ Preview works and deployment ready

---

## FINAL VERIFICATION CHECKLIST

Check all critical items passed:

### Functionality ✅
- [ ] Login successful
- [ ] Dashboard accessible
- [ ] Project created
- [ ] Generation submitted
- [ ] Pipeline completed without errors
- [ ] Code preview loads
- [ ] Code is real (not scaffold)
- [ ] All stages validated

### Code Quality ✅
- [ ] Multiple files generated (not single file)
- [ ] Proper component structure
- [ ] TypeScript code present
- [ ] Tailwind CSS styling
- [ ] Real implementation (not placeholder)

### Performance ✅
- [ ] Dashboard loads < 3 seconds
- [ ] Pages respond quickly
- [ ] Preview renders smoothly
- [ ] No timeouts
- [ ] No memory errors
- [ ] All animations smooth

### Error Handling ✅
- [ ] No error messages in UI
- [ ] No console errors
- [ ] Graceful error recovery (if any errors)
- [ ] Diagnostics show healthy status
- [ ] Worker health OK

### Integration ✅
- [ ] Database connected (user profiles load)
- [ ] AI provider responding (generation completed)
- [ ] Queue system working (job processed)
- [ ] Cache working (page loads cached)
- [ ] Real-time features working (if any)

---

## SMOKE TEST RESULTS

### Overall Assessment: ✅ PASS or ❌ FAIL

**If all checks passed**:
- System is working correctly
- Ready to proceed to Phase 4 (production deployment)
- Generation pipeline is fully functional
- Code quality is acceptable

**If some checks failed**:
- Note the specific failing test
- Check error messages and logs
- May need to debug Phase 2 health checks
- Contact support with error details

---

## QUICK ISSUE RESOLUTION

### Generation takes too long (> 45 minutes)
- [ ] Check network connection
- [ ] Check browser console for JavaScript errors
- [ ] Refresh page and check job status
- [ ] Contact support if still running

### Preview doesn't load
- [ ] Clear browser cache
- [ ] Refresh preview
- [ ] Check if code files are generated
- [ ] Try different browser

### Deployment fails
- [ ] Verify all dependencies in package.json
- [ ] Check for missing environment variables
- [ ] Review build logs for errors
- [ ] May need code fixes before deployment

### Generation produces scaffold only
- [ ] This is a FAILURE - regenerate
- [ ] Check Phase 2 health metrics
- [ ] May indicate AI provider issues
- [ ] Try with simpler prompt

---

## TIMING REFERENCE

Expected timing:
- Login & Dashboard: 5 minutes
- Create Project: 5 minutes
- Submit Prompt: 2 minutes
- Monitor Generation: 10-30 minutes (depending on complexity)
- Verify Output: 10 minutes
- Test Preview: 10 minutes
- **Total**: 45 minutes to 1.5 hours

**Note**: Actual time depends on:
- Prompt complexity
- AI provider response time (OpenRouter latency)
- System load
- Network speed

---

## NEXT STEPS

Once all smoke tests pass (✅ PASS):

1. **Proceed to Phase 4**: Production Deployment
2. **Open**: `PHASE_4_PRODUCTION_DEPLOYMENT.md`
3. **Final step**: Merge to main and deploy to production
4. **Expected duration**: 1-2 hours

---

## SMOKE TEST SIGN-OFF

**Date Started**: _______________  
**Date Completed**: _______________  
**Tester Name**: _______________  
**Overall Result**: ☐ PASS  ☐ FAIL  
**Issues Found**: None ☐  Some ☐ (List below)

```
Issue 1: ________________________________
Impact: ________________________________

Issue 2: ________________________________
Impact: ________________________________
```

**Sign-off**: _______________  
**Ready for Phase 4**: ☐ Yes  ☐ No

---

**Smoke Testing Status**: READY TO EXECUTE  
**Expected Completion**: 1-2 hours from start  
**Success Criteria**: All checkboxes passed = ✅ PASS

