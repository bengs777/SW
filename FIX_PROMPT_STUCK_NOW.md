# 🆘 FIX: Prompt Tidak Bisa Diproses & Super Lambat

## DIAGNOSA CEPAT

**Masalah:** Prompt hang, "No response at all"
**Root Cause:** VPS deployment script BELUM dijalankan
**Status:** Services tidak running = API calls timeout

---

## ✅ SOLUSI CEPAT (30 menit)

### Step 1: Check Browser Console (1 min)
```
1. Buka browser: Press F12 atau Ctrl+Shift+I
2. Klik tab "Console"
3. Klik "Start building" lagi
4. Lihat error message di console

Dokumentasikan error apa yang muncul
```

### Step 2: SSH ke VPS (2 min)
```bash
# Dari laptop/PC local:
ssh root@8.215.40.119

# Masukkan password VPS
```

### Step 3: Check PM2 Services (2 min)
```bash
# Saat sudah SSH ke VPS:
pm2 list

# Expected output:
# ┌─────────────────────────────────────────────────────────────────────┐
# │ id  │ name                    │ namespace   │ version │ mode    │ pm2 │
# ├─────┼─────────────────────────┼─────────────┼─────────┼─────────┼─────┤
# │ 0   │ swift-generation-worker │ default     │ 1.0.0   │ fork    │ N/A │
# │ 1   │ swift-sandbox           │ default     │ 1.0.0   │ fork    │ N/A │
# │ 2   │ swift-api               │ default     │ 1.0.0   │ fork    │ N/A │
# └─────────────────────────────────────────────────────────────────────┘

# Jika muncul text above = GOOD (services running)
# Jika error atau kosong = BAD (services not running, lanjut ke Step 4)
```

### Step 4A: Jika Services RUNNING (pm2 list shows 3 services)
```bash
# Check health endpoints
curl http://localhost:3001/health
curl http://localhost:3002/health
curl http://localhost:3000/api/health

# Expected: {"status":"ok"} atau 200 OK
# Jika ada error: lanjut ke Step 5
```

### Step 4B: Jika Services NOT RUNNING (pm2 list kosong/error)
```bash
# Jalankan deployment script sekarang
cd /root/sw
./scripts/vps-production-deploy.sh

# Tunggu sampai selesai (5-10 min)
# Jangan di-interrupt!

# Setelah selesai:
pm2 list

# Verify semua 3 services running
```

### Step 5: Check Service Logs (5 min)
```bash
# Jika services running tapi masih error:

# Check generation worker
pm2 logs swift-generation-worker --lines 50

# Check sandbox
pm2 logs swift-sandbox --lines 50

# Check API
pm2 logs swift-api --lines 50

# Lihat error apa yang muncul
# Copy-paste error ke sini untuk debugging lebih lanjut
```

### Step 6: Test Endpoint dari Browser (2 min)
```
Buka browser, pergi ke:

http://ai-swift.biz.id/api/health
http://ai-swift.biz.id:3001/health
http://ai-swift.biz.id:3002/health

Expected: Semua menunjukkan 200 OK atau {status: "ok"}
Jika error: Ada issue dengan reverse proxy Nginx
```

### Step 7: Coba Prompt Lagi (1 min)
```
1. Buka https://ai-swift.biz.id
2. Klik "Langkukan Prompt"
3. Isikan prompt
4. Klik "Start building"
5. Lihat apakah berjalan sekarang
```

---

## DEBUGGING TABLE

| Symptom | Cause | Fix |
|---------|-------|-----|
| `pm2 list` kosong | Scripts tidak dijalankan | Jalankan `vps-production-deploy.sh` |
| Service error | Environment vars salah | Check `.env` di VPS, verify DATABASE_URL & REDIS_URL |
| `curl /health` timeout | Service tidak listening | Check PM2 logs, restart dengan `pm2 restart all` |
| Nginx 502 Bad Gateway | Service crashed | `pm2 logs [service-name]`, cari error, fix |
| Prompt still hanging | Multiple issues | Cek semua di atas, jika masih error lanjut ke Debugging Lanjutan |

---

## DEBUGGING LANJUTAN (Jika masih bermasalah)

### 1. Check Environment Variables VPS
```bash
# SSH ke VPS
cat /root/sw/.env

# Verify ada:
DATABASE_URL=
DIRECT_URL=
REDIS_URL=
OPENROUTER_API_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

### 2. Test Database Connection
```bash
# SSH ke VPS, jalankan:
node -e "
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.\$queryRaw\`SELECT 1\`
  .then(() => console.log('DB OK'))
  .catch(e => console.error('DB ERROR:', e.message));
"
```

### 3. Test Redis Connection
```bash
# SSH ke VPS, jalankan:
redis-cli ping

# Expected output: PONG
# Jika error: Redis service tidak jalan
```

### 4. Check Nginx Logs
```bash
# SSH ke VPS
tail -50 /var/log/nginx/error.log
tail -50 /var/log/nginx/access.log

# Cari error 502, connection refused, dll
```

### 5. Restart Everything
```bash
# SSH ke VPS, jalankan:
pm2 restart all
pm2 save
systemctl restart nginx

# Tunggu 10 detik
# Coba lagi
```

---

## QUICK COMMANDS (Copy-paste ready)

### SSH + Check semua dalam 1 menit
```bash
ssh root@8.215.40.119 "pm2 list && echo '---' && curl -s http://localhost:3000/api/health && echo '---' && curl -s http://localhost:3001/health && echo '---' && curl -s http://localhost:3002/health"
```

### SSH + Deploy services jika belum
```bash
ssh root@8.215.40.119 "cd /root/sw && ./scripts/vps-production-deploy.sh"
```

### SSH + View logs realtime
```bash
ssh root@8.215.40.119 "pm2 logs swift-generation-worker"
```

---

## NEXT STEPS SETELAH FIX

Saat ini langsung:

1. **Step 1:** Buka browser console (F12), cek error
2. **Step 2:** SSH ke VPS, check `pm2 list`
3. **Step 3:** Jika tidak ada services, jalankan deployment script
4. **Step 4:** Test endpoints dengan curl
5. **Step 5:** Coba prompt lagi

**Lapor apa yang terjadi di step mana!**

---

## REFERENCE FILES

- `DEPLOYMENT_STEP_BY_STEP.md` - Full deployment guide
- `DEPLOYMENT_QUICK_REFERENCE.md` - Commands reference
- `.env` template - See `VPS_ENV_SETUP.md`

