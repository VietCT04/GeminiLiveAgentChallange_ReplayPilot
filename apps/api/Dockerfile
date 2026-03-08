FROM node:20-slim

WORKDIR /workspace

COPY package*.json ./
COPY apps/api/package*.json apps/api/
COPY packages/shared/package*.json packages/shared/

RUN npm ci

COPY . .

RUN npm run build -w @replaypilot/api

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "run", "start", "-w", "@replaypilot/api"]
