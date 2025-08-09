# استفاده از تصویر رسمی Node.js
FROM node:18-alpine

# ایجاد دایرکتوری برنامه
WORKDIR /app

# کپی package.json و package-lock.json
COPY package*.json ./

# نصب dependencies
RUN npm install

# کپی تمام فایل‌های پروژه
COPY . .

# ساخت برنامه (اگر نیاز باشد)
RUN npm run build

# پورت مورد استفاده
EXPOSE 3000

# دستور اجرای برنامه
CMD ["node", "index.js"]