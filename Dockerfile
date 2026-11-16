FROM node:24.22.2-alpine3.24@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build

WORKDIR /usr/src/app

COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci

COPY ./src/ ./src/
RUN npm run build

FROM node:24.22.2-alpine3.24@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
WORKDIR /usr/src/app
# copy built files and dependencies
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/build ./build
# copy package info for npm
COPY package*.json ./
# copy NeTEx schema files
COPY ./src/netex/xsd/ ./src/netex/xsd/

CMD npm run convert -- --gtfs /inputs/gtfs.zip --netex /outputs
