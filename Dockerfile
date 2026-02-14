FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/ packages/
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=build /app/packages packages/
RUN npm ci --omit=dev
COPY --from=build /app/dist dist/
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/server.js"]
