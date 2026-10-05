FROM node:26-alpine3.23@sha256:c3c6e314fd42e41962360b2482fc18d150beb47976c3aa7b8b9689d7ef42a5c2
WORKDIR /app
COPY containers/worker-package.json ./package.json
COPY containers/worker-package-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --cache=/tmp/npm-cache \
    && rm -rf /tmp/npm-cache /root/.npm /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx
COPY dist ./dist
USER 10001:10001
ENV NODE_ENV=production
ENV NODE_OPTIONS=--import=/app/dist/native-loader.mjs
CMD ["node", "dist/worker.js"]
