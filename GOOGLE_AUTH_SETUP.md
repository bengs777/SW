# Google OAuth Setup & Troubleshooting

## Error: AccessDenied pada Production (https://swift.jbb.my.id)

### Root Causes & Solutions

---

## 1️⃣ CRITICAL: Set Environment Variables di Vercel

**Status**: ⚠️ REQUIRED - Jika belum diset, login TIDAK akan berfungsi

### Step-by-Step:

1. Buka [Vercel Dashboard](https://vercel.com/dashboard)
2. Pilih project **Swift**
3. Klik **Settings** (tab atas)
4. Di sidebar, klik **Environment Variables**
5. Tambahkan variabel berikut:

| Variable Name | Value | Source | Example |
|---|---|---|---|
| `NEXTAUTH_URL` | **WAJIB** | Manual input | `https://swift.jbb.my.id` |
| `NEXTAUTH_SECRET` | **WAJIB** | Generate atau copy dari `.env` | `eyJhbGciOiJIUzI1NiIsInR5c...` |
| `GOOGLE_CLIENT_ID` | **WAJIB** | Google Console | `123456789-abc123def456.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | **WAJIB** | Google Console | `GOCSPX-1a2b3c4d5e6f...` |
| `TURSO_DATABASE_URL` | **WAJIB** | From `.env` | `libsql://rapelit-...turso.io` |
| `TURSO_AUTH_TOKEN` | **WAJIB** | From `.env` | `eyJhbGciOiJFZERTQSI...` |

⚠️ **IMPORTANT**: Paste nilai EXACT dari `.env` file lokal kamu untuk:
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

**After adding**: Click "Save" untuk setiap variabel.

---

## 2️⃣ Verify Google OAuth Credentials

**Status**: ⚠️ MUST VERIFY - Jika salah, Google akan reject request

### Check di Google Cloud Console:

1. Buka [Google Cloud Console](https://console.cloud.google.com/)
2. Pilih project yang sama dengan `GOOGLE_CLIENT_ID` kamu
3. Pergi ke **APIs & Services** → **Credentials**
4. Cari OAuth 2.0 Client ID (type: Web application)
5. Klik untuk edit, scroll ke **Authorized redirect URIs**
6. **HARUS** ada entri EXACT ini:
   ```
   https://swift.jbb.my.id/api/auth/callback/google
   ```

### Jika tidak ada:
- Klik **ADD URI**
- Paste: `https://swift.jbb.my.id/api/auth/callback/google`
- Klik **Save**

⚠️ **PENTING**: URL harus EXACT match dengan `NEXTAUTH_URL` + `/api/auth/callback/google`

---

## 3️⃣ Verify NEXTAUTH_URL Format

**Status**: ℹ️ COMMON ISSUE - Sering typo atau format salah

Pastikan:
- ✅ Format: `https://swift.jbb.my.id` (no trailing slash)
- ✅ Domain cocok dengan URL browser
- ✅ HTTPS (bukan HTTP)
- ❌ Jangan: `swift.jbb.my.id` (missing https://)
- ❌ Jangan: `https://swift.jbb.my.id/` (trailing slash)

---

## 4️⃣ Redeploy di Vercel

**Status**: ℹ️ REQUIRED - Code changes won't take effect sampai redeploy

1. Setelah set semua env vars, buka Vercel dashboard
2. Pilih project **Swift**
3. Klik **Deployments** tab
4. Cari deployment terbaru (commit `29300b7`)
5. Klik **Redeploy** button (or wait for automatic redeploy if new commit pushed)
6. Monitor **Build Logs** untuk errors

---

## 5️⃣ Test Production Login

**Status**: ✅ VALIDATION - Jika langkah 1-4 benar, ini harus work

1. Buka https://swift.jbb.my.id
2. Klik **Sign in with Google** button
3. Pilih atau login dengan Google account
4. Tunggu redirect callback...
5. ✅ Harus sampai ke dashboard atau create workspace screen

### Jika MASIH error:

#### Check Browser Console:
- Press `F12` → Console tab
- Ada error message? Screenshot & share

#### Check Vercel Function Logs:
1. Vercel dashboard → Deployments → Recent
2. Klik deployment yang aktif
3. **Function Logs** tab
4. Cari error terkait NextAuth atau database
5. Share error output

#### Check auth.ts Implementation:
- Line 44-47: Google provider config
- Line 143-162: signIn callback untuk database upsert
- Pastikan tidak ada syntax error

---

## Checklist Before Asking for Help

```
□ Set NEXTAUTH_URL di Vercel
□ Set NEXTAUTH_SECRET di Vercel
□ Set GOOGLE_CLIENT_ID di Vercel
□ Set GOOGLE_CLIENT_SECRET di Vercel
□ Set TURSO_DATABASE_URL di Vercel
□ Set TURSO_AUTH_TOKEN di Vercel
□ Verify redirect URI di Google Console: https://swift.jbb.my.id/api/auth/callback/google
□ Redeploy di Vercel (atau tunggu auto-redeploy)
□ Test login di https://swift.jbb.my.id
□ Check browser console for errors (F12)
□ Check Vercel function logs for backend errors
```

---

## Quick Reference: Auth Flow

```
User clicks "Sign in with Google"
    ↓
Redirect to: https://accounts.google.com/o/oauth2/auth?...&redirect_uri=https://swift.jbb.my.id/api/auth/callback/google
    ↓
User approves Google permissions
    ↓
Google redirects back to: https://swift.jbb.my.id/api/auth/callback/google?code=...&state=...
    ↓
NextAuth validates code with Google API (uses GOOGLE_CLIENT_SECRET)
    ↓
If valid: Create/update user in database via auth.ts signIn callback
    ↓
Set JWT token (signed with NEXTAUTH_SECRET)
    ↓
Redirect to: https://swift.jbb.my.id/dashboard
```

---

## Files Modified (Commit 29300b7)

- ✅ `/auth.ts` - NextAuth config dengan Google provider
- ✅ `/lib/env.ts` - Environment variable validation
- ✅ `/lib/db/client.ts` - Prisma client dengan libSQL adapter (Turso support)
- ✅ `/prisma/schema.prisma` - Driver adapter preview feature
- ✅ `/package.json` - Prisma libSQL adapter dependencies

All code is ready. Only **environment variables** need to be set in Vercel.

---

## Need Help?

Share:
1. Screenshot dari Vercel Environment Variables page
2. Browser console error (F12 → Console tab)
3. Vercel function logs (Deployments → Recent → Function Logs)
