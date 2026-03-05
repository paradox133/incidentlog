FROM node:20-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY src/ ./src/
EXPOSE 3099
CMD ["node", "src/index.js"]
