FROM node:alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY main/package*.json ./main/
COPY api/package*.json ./api/

RUN cd main && npm install
RUN cd api && npm install

COPY . .

CMD ["node", "main/index.js", "1"]
