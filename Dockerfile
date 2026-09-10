FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
ENV PORT=4177
EXPOSE 4177
CMD ["node", "src/server.mjs"]
