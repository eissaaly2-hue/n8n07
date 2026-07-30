# مرحلة البناء
FROM node:22.22.0-bookworm-slim AS builder

WORKDIR /build

# تثبيت pnpm
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate

# نسخ ملفات المشروع الأساسية
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/ packages/
COPY scripts/ scripts/
COPY patches/ patches/

# تثبيت الاعتماديات
RUN pnpm install --no-frozen-lockfile

# بناء المشروع (تجاهل n8n-nodes-base لتجنب الأخطاء)
RUN pnpm run build --filter=!n8n-nodes-base

# ============================================================
# مرحلة التشغيل
FROM node:22.22.0-bookworm-slim

# تثبيت المتطلبات الأساسية
RUN apt-get update && apt-get install -y \
    git \
    openssl \
    tini \
    graphicsmagick \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/node

# نسخ الملفات المبنية
COPY --from=builder /build/packages/cli/bin/n8n /usr/local/bin/n8n
COPY --from=builder /build/node_modules /home/node/node_modules

# إنشاء مجلد البيانات
RUN mkdir -p /home/node/.n8n && chown -R node:node /home/node

EXPOSE 5678

ENV N8N_PORT=5678 \
    NODE_ENV=production

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/usr/local/bin/n8n"]
