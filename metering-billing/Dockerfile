FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/index.js"]
