# استخدم Debian بدلاً من Alpine لتجنب مشكلة MUSL
ARG NODE_VERSION=22.22.0
FROM node:${NODE_VERSION}-bookworm-slim AS builder

WORKDIR /app

# تثبيت pnpm
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate

# نسخ ملفات المشروع
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/ packages/
COPY scripts/ scripts/
COPY patches/ patches/

# تثبيت الاعتماديات
RUN pnpm install --no-frozen-lockfile

# بناء المشروع (تجاهل n8n-nodes-base لتجنب الأخطاء)
RUN pnpm run build --filter=!n8n-nodes-base

EXPOSE 5678
CMD ["pnpm", "start"]
