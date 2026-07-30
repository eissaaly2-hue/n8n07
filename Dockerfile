# بناء المرحلة 1: بناء التطبيق
FROM node:22.22.0-bookworm-slim AS builder

WORKDIR /build

# تثبيت pnpm
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate

# نسخ ملفات المشروع
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/ packages/
COPY scripts/ scripts/
COPY patches/ patches/

# تثبيت الاعتماديات (بدون --frozen-lockfile)
RUN pnpm install --no-frozen-lockfile

# بناء المشروع (تجاهل n8n-nodes-base لتجنب الأخطاء)
RUN pnpm run build --filter=!n8n-nodes-base

# ============================================================
# المرحلة 2: الصورة النهائية للتشغيل
FROM node:22.22.0-bookworm-slim

# تثبيت المتطلبات الضرورية لتشغيل n8n
RUN apt-get update && apt-get install -y \
    git \
    openssl \
    tini \
    graphicsmagick \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/node

# نسخ الملفات المبنية من مرحلة البناء
COPY --from=builder /build/packages/cli/bin/n8n /usr/local/bin/n8n
COPY --from=builder /build/node_modules /home/node/node_modules

# إنشاء مجلد لبيانات n8n
RUN mkdir -p /home/node/.n8n && chown -R node:node /home/node

# تعيين المنفذ
EXPOSE 5678

# متغيرات البيئة الأساسية
ENV N8N_PORT=5678 \
    N8N_ENCRYPTION_KEY=your-encryption-key \
    N8N_USER_MANAGEMENT_DISABLED=false \
    NODE_ENV=production

# استخدام tini كـ entrypoint
ENTRYPOINT ["/usr/bin/tini", "--"]

CMD ["node", "/usr/local/bin/n8n"]
