FROM mcr.microsoft.com/playwright:v1.52.0-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY src ./src

ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]
