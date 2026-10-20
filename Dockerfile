# Use Node.js 18 as the base image
FROM node:18

# Set working directory
WORKDIR /usr/src/app

# Copy package files first for better caching
COPY package*.json ./

# Install app dependencies (only once for cache efficiency)
RUN npm install

# Install required libraries explicitly (in case they’re not in package.json)
RUN npm install ioredis@5.3.2 socket.io@4.8.1 openai@6.6.0 dotenv ws@8.18.3



# Install nodemon globally for live reload during development
RUN npm install -g nodemon

# Copy the rest of your source code
COPY . .

# Expose the app port
EXPOSE 3000

# Set default environment variables (can be overridden in docker-compose)
ENV REDIS_HOST=redis
ENV REDIS_PORT=6379
ENV OPENAI_API_KEY=changeme

# Start app using nodemon for auto-reload
CMD ["nodemon", "--legacy-watch", "server.js"]
