FROM node:lts-alpine

# RUN apk update || : && apk add py3-pip

RUN mkdir -p /home/node/app/node_modules && chown -R node:node /home/node/app

# Create app directory
WORKDIR /home/node/app

# Install base modules
COPY package*.json ./
USER node
RUN npm install

# Bundle app source
COPY --chown=node . .
COPY --chown=node ./config/config.json.example ./config/config.json

# Install RevPi Lib sub modules
WORKDIR /home/node/app/lib/RevPi-Interface
RUN npm install

# Run App
WORKDIR /home/node/app
CMD node app.js