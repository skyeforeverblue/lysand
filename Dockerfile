# Use 1.1.4 for building to prevent a Unicode bug with 1.1.5+
# Temporary until they fix it
FROM oven/bun:1.1.4-alpine as base

RUN apk add --no-cache libstdc++

# Install dependencies into temp directory
# This will cache them and speed up future builds
FROM base AS install

RUN mkdir -p /temp
COPY . /temp
WORKDIR /temp
RUN bun install --production

FROM base as build

# Copy the project
RUN mkdir -p /temp
COPY . /temp
# Copy dependencies
COPY --from=install /temp/node_modules /temp/node_modules
# Build the project
WORKDIR /temp
RUN bun run build
WORKDIR /temp/dist

# Copy production dependencies and source code into final image
FROM oven/bun:1.1.12-alpine

RUN apk add --no-cache libstdc++

# Create app directory
RUN mkdir -p /app
COPY --from=build /temp/dist /app/dist
COPY entrypoint.sh /app

LABEL org.opencontainers.image.authors "Gaspard Wierzbinski (https://cpluspatch.dev)"
LABEL org.opencontainers.image.source "https://github.com/lysand-org/lysand"
LABEL org.opencontainers.image.vendor "Lysand Org"
LABEL org.opencontainers.image.licenses "AGPL-3.0-or-later"
LABEL org.opencontainers.image.title "Lysand Server"
LABEL org.opencontainers.image.description "Lysand Server docker image"

# CD to app
WORKDIR /app
ENV NODE_ENV=production
ENTRYPOINT [ "/bin/sh", "/app/entrypoint.sh" ]
# Run migrations and start the server
CMD [ "cli", "start" ]
