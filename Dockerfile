FROM node:22-slim

# Install system deps for canvas + fonts
RUN apt-get update && apt-get install -y \
  fonts-dejavu-core \
  fonts-liberation \
  fontconfig \
  wget \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Download GG Sans font files (Discord's font, hosted on GitHub)
RUN mkdir -p /app/fonts && \
  wget -q -O /app/fonts/gg-sans-normal.ttf \
    "https://github.com/nicholasgasior/discord-gg-sans/raw/main/GGSans-Normal.ttf" && \
  wget -q -O /app/fonts/gg-sans-bold.ttf \
    "https://github.com/nicholasgasior/discord-gg-sans/raw/main/GGSans-Bold.ttf" && \
  fc-cache -f -v

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
