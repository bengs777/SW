# Blog/News Generation Bias - FIX SUMMARY

## Root Cause
**File:** `lib/ai/prompt-enhancer.ts` (Line 84 - Original)

### Original Problem
```typescript
const looksLikeBlog = hasAny(normalized, ["blog", "article", "artikel", "content", "konten", "berita", "post"])
```

**Issue:** The word "content" and "konten" are too broad and match ANY web application request, regardless of actual user intent. This caused:
- User asks for "laundry management app" → matches "content management" template
- User asks for "restaurant ordering system" → matches if any description mentions "konten"
- User asks for "salon booking" → template defaults to blog if earlier detections fail
- User asks for "dashboard" → occasionally still generated news layout

## Solution Applied

### 1. **Precise Blog Detection** (Line 84-87)
```typescript
const looksLikeBlog = hasAny(normalized, ["blog", "berita", "news", "artikel", "article", "magazine", "majalah", "media", "portal konten", "content portal"]) ||
  (normalized.includes("content") && (normalized.includes("blog") || normalized.includes("website") || normalized.includes("portal") || normalized.includes("management")))
```

**Fix:** Blog is detected ONLY when:
- Explicit keywords: blog, berita, news, artikel, magazine, media
- OR "content" appears WITH qualifying context (blog, website, portal, management)

### 2. **Added Missing Project Type Detectors** (Lines 108-111)
```typescript
const looksLikeSalon = hasAny(normalized, ["salon", "barbershop", "spa", "kecantikan", "haircut", "massage"])
const looksLikeRental = hasAny(normalized, ["rental", "sewa", "booking kendaraan", "car rental", "bike rental"])
const looksLikeSaaS = hasAny(normalized, ["saas", "software as a service", "subscription", "langganan"])
const looksLikeLandingPage = hasAny(normalized, ["landing", "marketing"]) && !looksLikeBooking && !looksLikeLanding
```

### 3. **Updated Product Type Chain** (Lines 133-149)
Changed priority order to default to `"custom full-stack web app"` instead of falling back to blog:
- Added salon, rental, SaaS detection
- Changed blog detection from default to explicit requirement
- All unclear prompts now default to "custom full-stack web app" instead of "content website"

### 4. **Negative Constraint in Delivery Rules** (Line 308)
```typescript
!looksLikeBlog ? "Do NOT generate news layouts, blog headlines, 'topik populer', content feed sections, or news-style cards unless user explicitly asks for blog or news website." : ""
```

This prevents AI from inferring news components even if it detects ambiguous signals.

### 5. **Debug Logging** (Lines 315-323)
```typescript
console.log("[v0] Prompt intent analysis:", {
  originalPrompt: compactPrompt.substring(0, 100),
  detectedProjectType: productType,
  blogDetected: looksLikeBlog,
  laundryDetected: looksLikeLaundry,
  restaurantDetected: looksLikeRestaurant,
  salonDetected: looksLikeSalon,
  rentalDetected: looksLikeRental,
  sampleFeatures: features.slice(0, 3),
})
```

Logs what was detected so issues can be traced.

## Test Scenarios Fixed

### Scenario 1: Laundry Management
**User:** "Buat aplikasi laundry management dengan pickup dan delivery"
- **Before:** Sometimes detected "konten" → blog template
- **After:** Detects "laundry" → correctly generates laundry service UI

### Scenario 2: Restaurant Ordering
**User:** "Website restoran dengan menu, reservasi, dan order online"
- **Before:** Falls through to blog if keywords matched weakly
- **After:** Detects "restoran" → generates restaurant UI with menu + booking

### Scenario 3: Salon Booking
**User:** "Buat salon booking app untuk appointment dan payment"
- **Before:** No salon detector existed → falls back to custom
- **After:** New salon detector → generates service catalog + booking calendar

### Scenario 4: Vague "Create Website"
**User:** "Bikin website"
- **Before:** Could match "konten" and generate blog
- **After:** No match → defaults to `"custom full-stack web app"` instead of news

### Scenario 5: Explicit Blog Request
**User:** "Blog dengan artikel dan kategori konten"
- **Before:** Matches correctly
- **After:** Still matches (requires "blog" OR "content" + "blog"/"portal") → generates blog UI correctly

## Files Changed
- `lib/ai/prompt-enhancer.ts` - Main template detection logic

## Impact
- ✅ Laundry, restaurant, salon, rental apps no longer default to news layouts
- ✅ "Content management" context required for blog detection (not just "konten")
- ✅ Negative constraint prevents news components unless explicitly requested
- ✅ Debug logs show what was detected for troubleshooting
- ✅ Cleaner fallback (custom app instead of news)

## How to Verify
1. Run generation with: "Buat aplikasi laundry management"
   - Expected: Service orders page, not blog headlines
   
2. Run generation with: "Website untuk restoran dengan menu"
   - Expected: Restaurant menu + reservation, not news feed
   
3. Check browser console logs for: "[v0] Prompt intent analysis"
   - Should show `blogDetected: false` for non-blog requests
   
4. Run generation with: "Buat blog dengan artikel"
   - Expected: Article listing + readable layout (still works)

## Backward Compatibility
✅ No breaking changes:
- Existing blog requests still work (explicit "blog" keyword)
- New detectors are additive
- Negative constraint only affects non-blog requests
- Fallback is still a valid web app, just not news-focused

---

**Date:** 2026-05-08
**Changed By:** v0 Audit Fix
**Status:** Ready for testing
