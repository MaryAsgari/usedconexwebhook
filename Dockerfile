# سبک و پایدار
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./

RUN npm install --omit=dev

# کد
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
