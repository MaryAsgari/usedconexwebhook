# Node 20 روی Alpine (کوچیک و سریع)
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# فقط فایل‌های لازم برای نصب
COPY package*.json ./
RUN npm ci --omit=dev

# بقیه سورس
COPY . .

# اسکریپت entrypoint: کلید سرویس‌اکانت GCP را از Secret به فایل می‌نویسیم
COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

ENTRYPOINT ["/entrypoint.sh"]
