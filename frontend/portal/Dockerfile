# syntax=docker/dockerfile:1
# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
# Vite bakes VITE_* into the bundle at build time (import.meta.env). The prod
# deploy workflow overrides these with the public HTTPS values (see
# .forgejo/workflows/deploy.yaml). Defaults keep a plain `docker build` usable.
#
# VITE_API_BASE empty => the SPA calls same-origin /api/v1/... which this image's
# nginx proxies to the api container (see nginx.conf).
ARG VITE_API_BASE=""
ENV VITE_API_BASE=$VITE_API_BASE
# Keycloak base URL as seen by the browser. In prod Keycloak is served under
# https://${DOMAIN}/auth behind the external proxy.
ARG VITE_KEYCLOAK_URL="http://localhost:8081"
ENV VITE_KEYCLOAK_URL=$VITE_KEYCLOAK_URL
ARG VITE_KEYCLOAK_REALM="voltpilot"
ENV VITE_KEYCLOAK_REALM=$VITE_KEYCLOAK_REALM
ARG VITE_KEYCLOAK_CLIENT_ID="voltpilot-frontend"
ENV VITE_KEYCLOAK_CLIENT_ID=$VITE_KEYCLOAK_CLIENT_ID
RUN npm run build

# ---- serve (nginx: SPA + /api and /auth reverse proxy) ----
FROM nginx:1.27-alpine AS run
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
