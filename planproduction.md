# Swift Production VPS Sandbox Plan

Target VPS: `8.215.40.119`

Target layanan:

- App utama tetap berjalan di Vercel: `https://www.ai-swift.biz.id`
- Sandbox runtime berjalan di VPS: `https://sandbox.ai-swift.biz.id`
- Generation worker berjalan di VPS via PM2
- Redis/BullMQ tetap menjadi queue utama
- Neon PostgreSQL dan Supabase Storage tetap sebagai managed services

Important security note:

- Jangan commit `.env`, `.env.local`, `.env.production`, `.env.sandbox`, atau `.env.vercel`.
- Root password VPS sudah pernah dibagikan lewat chat. Rotasi password root setelah SSH key/deploy user siap.
- Gunakan token baru untuk `SANDBOX_SERVICE_TOKEN` sebelum launch publik.
- Rotasi secret yang pernah terlihat di editor/chat, terutama Neon DB password dan Supabase service role key.

## 1. DNS

Buat atau verifikasi DNS record:

```bash
sandbox.ai-swift.biz.id A 8.215.40.119
```

Tunggu propagasi, lalu cek dari lokal:

```bash
nslookup sandbox.ai-swift.biz.id
```

Target hasil: domain resolve ke `8.215.40.119`.

## 2. Akses Awal VPS

Login pertama dari terminal lokal:

```bash
ssh root@8.215.40.119
```

Jangan tempel password ke script, repository, atau command history yang dibagikan.

Setelah login, update OS:

```bash
apt-get update
apt-get upgrade -y
apt-get install -y curl git nginx ufw certbot python3-certbot-nginx build-essential unzip fail2ban
```

## 3. SSH Hardening

Buat user deploy non-root:

```bash
adduser swift
usermod -aG sudo swift
mkdir -p /home/swift/.ssh
nano /home/swift/.ssh/authorized_keys
chown -R swift:swift /home/swift/.ssh
chmod 700 /home/swift/.ssh
chmod 600 /home/swift/.ssh/authorized_keys
```

Uji login dari terminal baru:

```bash
ssh swift@8.215.40.119
```

Setelah login SSH key berhasil, baru harden SSH:

```bash
cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl reload ssh
```

Rotasi password root setelah akses key-based berhasil:

```bash
passwd root
```

## 4. Firewall

Aktifkan hanya port publik yang diperlukan:

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose
```

Port internal tidak perlu dibuka publik:

- Sandbox runtime: `8080`
- Worker health: `4000`
- Generated preview ports: mulai dari `4300`

Nginx akan menjadi reverse proxy publik.

## 5. Runtime Node dan PM2

Install Node.js 22 dan PM2:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
npm install -g pm2
pm2 startup systemd -u root --hp /root
```

Jika nanti proses dijalankan dengan user `swift`, ulangi `pm2 startup` untuk user tersebut.

## 6. Clone dan Install Swift

Pakai path runtime standar:

```bash
cd /root
git clone https://github.com/bengs777/SW.git swift-runtime
cd /root/swift-runtime
npm ci
npm --prefix services/sandbox-runtime ci --omit=dev
npx prisma generate
```

Jika folder sudah ada:

```bash
cd /root/swift-runtime
git pull --ff-only origin main
npm ci
npm --prefix services/sandbox-runtime ci --omit=dev
npx prisma generate
```

## 7. Env VPS

Buat file env di VPS saja. Jangan upload ke Git.

```bash
cd /root/swift-runtime
install -m 600 /dev/null .env
install -m 600 /dev/null .env.sandbox
nano .env
nano .env.sandbox
```

Minimal `.env` untuk worker:

```bash
NODE_ENV=production
DATABASE_URL=<neon pooled url>
DIRECT_DATABASE_URL=<neon direct url>
REDIS_URL=<native redis url>
AGENTROUTER_API_KEY=<agentrouter key>
AGENTROUTER_BASE_URL=<agentrouter base url if used>
AGENTROUTER_MODEL=<production model>
SWIFT_AI_PROVIDER_NAME=agentrouter
SWIFT_GENERATION_EXECUTION_MODE=queue
SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true
SANDBOX_SERVICE_URL=https://sandbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=<new random token>
NEXTAUTH_SECRET=<same class strong secret used by app>
NEXTAUTH_URL=https://www.ai-swift.biz.id
NEXT_PUBLIC_APP_URL=https://www.ai-swift.biz.id
NEXT_PUBLIC_SUPABASE_URL=<supabase url>
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=<supabase publishable key>
SUPABASE_SERVICE_ROLE_KEY=<supabase service role key>
SUPABASE_STORAGE_BUCKET=<bucket>
```

Minimal `.env.sandbox` untuk sandbox runtime:

```bash
NODE_ENV=production
PORT=8080
HOST=0.0.0.0
SANDBOX_PUBLIC_BASE_URL=https://sandbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=<same token as Vercel and worker>
SWIFT_SANDBOX_ROOT=/data/swift-sandbox
SWIFT_SANDBOX_BASE_PORT=4300
SWIFT_SANDBOX_MAX_PROJECTS=12
SWIFT_SANDBOX_MAX_FILES=240
SWIFT_SANDBOX_MAX_TOTAL_BYTES=6291456
SWIFT_SANDBOX_MIN_FREE_BYTES=268435456
SWIFT_SANDBOX_PROJECT_IDLE_TTL_MS=1800000
SWIFT_SANDBOX_PROCESS_MAX_UPTIME_MS=1200000
NEXT_PUBLIC_SUPABASE_URL=<supabase url>
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=<supabase publishable key>
SUPABASE_SERVICE_ROLE_KEY=<supabase service role key>
SUPABASE_STORAGE_BUCKET=<bucket>
```

Generate token baru di VPS:

```bash
openssl rand -hex 32
```

## 8. Storage Sandbox

Siapkan folder sandbox:

```bash
mkdir -p /data/swift-sandbox
chmod 700 /data/swift-sandbox
df -h /data/swift-sandbox
```

Jika RAM VPS kecil, tambahkan swap 2 GB:

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
free -h
```

## 9. PM2 Services

Start worker dan sandbox dari ecosystem config:

```bash
cd /root/swift-runtime
pm2 delete swift-generation-worker || true
pm2 delete swift-sandbox || true
pm2 start ecosystem.config.cjs --only swift-generation-worker --update-env
pm2 start ecosystem.config.cjs --only swift-sandbox --update-env
pm2 save
pm2 status
```

Target:

- `swift-generation-worker` online
- `swift-sandbox` online
- Worker memakai port health `4000`
- Sandbox runtime memakai port `8080`

Lihat log jika ada error:

```bash
pm2 logs swift-generation-worker --lines 120
pm2 logs swift-sandbox --lines 120
```

## 10. Nginx Reverse Proxy

Buat config:

```bash
nano /etc/nginx/sites-available/swift-sandbox
```

Isi:

```nginx
server {
    listen 80;
    server_name sandbox.ai-swift.biz.id;

    client_max_body_size 10m;

    location = /worker/health {
        proxy_pass http://127.0.0.1:4000/health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
```

Enable site:

```bash
ln -sf /etc/nginx/sites-available/swift-sandbox /etc/nginx/sites-enabled/swift-sandbox
nginx -t
systemctl reload nginx
```

Pasang HTTPS:

```bash
certbot --nginx -d sandbox.ai-swift.biz.id
certbot renew --dry-run
```

## 11. Vercel Production Env

Set di Vercel Production:

```bash
SANDBOX_SERVICE_URL=https://sandbox.ai-swift.biz.id
SANDBOX_PUBLIC_BASE_URL=https://sandbox.ai-swift.biz.id
SANDBOX_SERVICE_TOKEN=<same token as VPS>
SWIFT_WORKER_HEALTH_URL=https://sandbox.ai-swift.biz.id/worker/health
SWIFT_GENERATION_EXECUTION_MODE=queue
SWIFT_DISABLE_SERVERLESS_GENERATION_FALLBACK=true
REDIS_URL=<same native redis url>
AGENTROUTER_API_KEY=<production key>
AGENTROUTER_MODEL=<same model as worker>
```

Redeploy production setelah env berubah:

```bash
npx vercel --prod
```

Atau push commit ke `main` jika GitHub auto-deploy aktif.

## 12. Health Checks

Di VPS:

```bash
curl -i http://127.0.0.1:8080/health
curl -i http://127.0.0.1:4000/health
curl -i https://sandbox.ai-swift.biz.id/health
curl -i https://sandbox.ai-swift.biz.id/worker/health
```

Di repo lokal atau VPS:

```bash
cd /root/swift-runtime
npm run deploy:readiness
```

Di lokal setelah Vercel deploy:

```bash
npm run postdeploy:health:prod
```

Target akhir:

- `READY_FOR_DEPLOY`
- `POST_DEPLOY_HEALTH_OK`
- `/api/health` status `healthy`
- `database=ok`
- `queue=ok`
- `worker=ok`
- `deployment=ok`
- Sandbox `/health` status `healthy`

## 13. Queue/Worker Validation

Pastikan tidak ada worker lama yang menulis heartbeat stalled:

```bash
pm2 status
ps -eo pid,ppid,lstart,cmd | grep -Ei 'swift-generation|workers/index|run-ts-script|node' | grep -v grep
```

Jika readiness melihat worker lama seperti `generation:local:14`, cari sumber lain yang memakai Redis production lama:

- VPS lain
- container lama
- Railway/Render/Fly.io lama
- local dev yang masih pakai `REDIS_URL` production
- service nanoclaw/openclaw lama yang menjalankan worker

Patch terbaru sudah memakai heartbeat per-worker dan fallback DB, tetapi proses rogue tetap sebaiknya dimatikan.

## 14. Production Smoke Test

Jalankan dari dashboard:

1. Login ke `https://www.ai-swift.biz.id`
2. Buat project baru
3. Prompt kecil: `Buat landing page SaaS sederhana dengan pricing dan form kontak`
4. Pastikan job masuk queue, tidak muncul `Swift queue belum siap menerima job`
5. Pastikan preview terbuka tanpa error `Babel is not defined`
6. Pastikan sandbox build/runtime smoke selesai
7. Coba retry job satu kali
8. Coba upload attachment kecil
9. Cek error log project kosong dari error queue/sandbox

## 15. Monitoring Harian

Command cepat:

```bash
pm2 status
pm2 logs swift-generation-worker --lines 80
pm2 logs swift-sandbox --lines 80
df -h
free -h
systemctl status nginx --no-pager
curl -s https://www.ai-swift.biz.id/api/health | jq
curl -s https://sandbox.ai-swift.biz.id/health | jq
```

Jika `jq` belum ada:

```bash
apt-get install -y jq
```

## 16. Update/Redeploy VPS

Setiap ada commit baru:

```bash
cd /root/swift-runtime
git pull --ff-only origin main
npm ci
npm --prefix services/sandbox-runtime ci --omit=dev
npx prisma generate
pm2 restart swift-generation-worker --update-env
pm2 restart swift-sandbox --update-env
pm2 save
npm run deploy:readiness
```

## 17. Rollback

Jika deploy baru bermasalah:

```bash
cd /root/swift-runtime
git log --oneline -5
git checkout <last-good-commit>
npm ci
npm --prefix services/sandbox-runtime ci --omit=dev
npx prisma generate
pm2 restart swift-generation-worker --update-env
pm2 restart swift-sandbox --update-env
pm2 save
```

Rollback Vercel:

```bash
npx vercel rollback
```

## 18. Done Criteria

Production dianggap ready jika semua ini terpenuhi:

- VPS hanya membuka port 22, 80, 443.
- Root password sudah dirotasi.
- SSH key login berhasil.
- Password SSH login dimatikan.
- PM2 `swift-generation-worker` online.
- PM2 `swift-sandbox` online.
- Nginx HTTPS untuk `sandbox.ai-swift.biz.id` aktif.
- `https://sandbox.ai-swift.biz.id/health` healthy.
- `https://sandbox.ai-swift.biz.id/worker/health` healthy.
- Vercel env production memakai sandbox URL dan token yang sama.
- `npm run deploy:readiness` menghasilkan `READY_FOR_DEPLOY`.
- `npm run postdeploy:health:prod` menghasilkan `POST_DEPLOY_HEALTH_OK`.
- Generate, preview, retry, dan attachment smoke test berhasil.
- Tidak ada `.env*` tracked di Git.
- Semua secret yang pernah terekspos sudah dirotasi.
