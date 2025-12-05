FROM node:22-alpine

# Install build dependencies for better-sqlite3
# Workaround for busybox trigger error on ARM64: install busybox first, then other packages
RUN apk update && apk add --no-cache --virtual .build-deps python3 make g++ || \
    (apk add --no-cache busybox && apk add --no-cache python3 make g++)

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 8085

CMD ["node", "dist/server.js"]

