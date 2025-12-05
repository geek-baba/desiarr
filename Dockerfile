FROM node:22-alpine

# Install build dependencies for better-sqlite3
# Update package index first, then install dependencies
RUN apk update && apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 8085

CMD ["node", "dist/server.js"]

