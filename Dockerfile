FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build

WORKDIR /usr/src/app

COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci

COPY ./src/ ./src/
RUN npm run build

FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
WORKDIR /usr/src/app
# copy built files and dependencies
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/build ./build
# copy package info for npm
COPY package*.json ./
# copy NeTEx schema files
COPY ./src/netex/xsd/ ./src/netex/xsd/

CMD npm run convert -- --gtfs /inputs/gtfs.zip --netex /outputs
