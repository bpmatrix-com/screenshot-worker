FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY src ./src

ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]
