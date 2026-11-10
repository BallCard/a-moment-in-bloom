FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=7860
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY server ./server
USER node
EXPOSE 7860
CMD ["node","server/index.mjs"]
