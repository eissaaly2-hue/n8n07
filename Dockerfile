FROM node:22.22.0-bookworm-slim

WORKDIR /app

# تثبيت المتطلبات الأساسية
RUN apt-get update && apt-get install -y \
    git \
    openssl \
    tini \
    graphicsmagick \
    && rm -rf /var/lib/apt/lists/*

# تثبيت n8n عالمياً
RUN npm install -g n8n

# إنشاء مجلد البيانات
RUN mkdir -p /home/node/.n8n && chown -R node:node /home/node

# تعيين المنفذ
EXPOSE 5678

# متغيرات البيئة الأساسية
ENV NODE_ENV=production \
    N8N_PORT=5678 \
    N8N_PROTOCOL=https \
    N8N_HOST=0.0.0.0 \
    WEBHOOK_URL=https://new-eissa-my-n8n-automation.hf.space \
    N8N_EDITOR_BASE_URL=https://new-eissa-my-n8n-automation.hf.space \
    N8N_ENCRYPTION_KEY=your-encryption-key-here

# استخدام tini كـ entrypoint
ENTRYPOINT ["/usr/bin/tini", "--"]

# تشغيل n8n
CMD ["n8n", "start"]
