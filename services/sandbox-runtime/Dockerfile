FROM node:22-bookworm-slim

WORKDIR /app

COPY services/sandbox-runtime/package*.json ./
RUN npm install --omit=dev

COPY services/sandbox-runtime/server.mjs ./

ENV NODE_ENV=production
ENV SWIFT_SANDBOX_ROOT=/data/swift-sandbox
ENV SWIFT_SANDBOX_BASE_PORT=4300

EXPOSE 8080

CMD ["npm", "start"]
