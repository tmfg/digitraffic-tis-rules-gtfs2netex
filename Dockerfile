ARG NODE_VERSION=19.9.0
FROM node:${NODE_VERSION}-alpine AS build

WORKDIR /usr/src/app

COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci

COPY ./src/ ./src/
RUN npm run build

FROM node:${NODE_VERSION}-alpine
WORKDIR /usr/src/app
# copy built files and dependencies
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/build ./build
# copy package info for npm
COPY package*.json ./
# copy NeTEx schema files
COPY ./src/netex/xsd/ ./src/netex/xsd/

CMD npm run convert -- --gtfs /inputs/gtfs.zip --netex /outputs
