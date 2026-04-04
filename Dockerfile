FROM node:22-slim

# Install fonts for canvas text rendering
RUN apt-get update && apt-get install -y \
  fonts-dejavu-core \
  fonts-liberation \
  fontconfig \
  && fc-cache -f -v \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
