<<<<<<< HEAD
FROM node:22-alpine
=======
FROM node:20-alpine
>>>>>>> 985a519 (feat: initialize hello-world-app with Shopify integration and Prisma setup)
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN npm run build

CMD ["npm", "run", "docker-start"]
