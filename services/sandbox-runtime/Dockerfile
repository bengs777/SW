FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.mjs ./

ENV NODE_ENV=production
ENV PORT=8080
ENV SWIFT_SANDBOX_ROOT=/tmp/swift-sandboxes
ENV SWIFT_SANDBOX_BASE_PORT=4300

EXPOSE 8080

CMD ["npm", "start"]
