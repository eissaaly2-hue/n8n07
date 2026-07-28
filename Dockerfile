# Dockerfile في جذر المشروع
FROM node:22.22.0-alpine3.20

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

# بناء المشروع
RUN pnpm run build

EXPOSE 5678
CMD ["pnpm", "start"]
