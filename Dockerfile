ARG NODE_VERSION=19.9.0
FROM node:${NODE_VERSION}-alpine AS build
# libxmljs2 has some really heavy dependencies; python and make

WORKDIR /usr/src/app

COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci

COPY ./src/ ./src/
RUN npm run build

FROM node:${NODE_VERSION}-alpine
WORKDIR /usr/src/app
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/build ./build

CMD npm run convert -- --gtfs /path/to/gtfs-file.zip --netex /path/to/netex-directory
