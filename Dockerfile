FROM node:20-alpine

RUN npm install -g n8n && \
    apk add --no-cache python3 py3-pip

RUN mkdir -p /home/node/.n8n && chown -R node:node /home/node/.n8n && chmod -R 755 /home/node/.n8n

USER node
WORKDIR /home/node/.n8n

EXPOSE 7860

ENV N8N_PORT=7860
ENV N8N_HOST=0.0.0.0
ENV N8N_LISTEN_ADDRESS=0.0.0.0
ENV N8N_PROTOCOL=https
ENV WEBHOOK_URL=https://new-eissa-my-n8n-automation1.hf.space
ENV N8N_EDITOR_BASE_URL=https://new-eissa-my-n8n-automation1.hf.space
ENV N8N_SECURE_COOKIE=false
ENV N8N_DIAGNOSTICS_ENABLED=false
ENV N8N_PERSONALIZATION_ENABLED=false
ENV N8N_USER_FOLDER=/home/node/.n8n
ENV DB_TYPE=sqlite
ENV DB_SQLITE_DATABASE=/home/node/.n8n/database.sqlite
ENV NODE_OPTIONS=--max-http-header-size=81920
ENV N8N_ENCRYPTION_KEY=8fd43164c27e3030f46a3a391645e5b7df6f4d6ecb83a4b22adb9bd511cc6845

CMD ["n8n"]
