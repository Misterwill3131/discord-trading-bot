FROM node:22-slim

# Install system deps for canvas + fonts
RUN apt-get update && apt-get install -y \
  fonts-dejavu-core \
  fonts-liberation \
  fontconfig \
  wget \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Download Inter font (open source, visually closest to Discord GG Sans)
RUN mkdir -p /app/fonts && \
  wget -q -O /app/fonts/inter-regular.ttf \
    "https://github.com/rsms/inter/raw/master/docs/font-files/Inter-Regular.ttf" && \
  wget -q -O /app/fonts/inter-semibold.ttf \
    "https://github.com/rsms/inter/raw/master/docs/font-files/Inter-SemiBold.ttf" && \
  wget -q -O /app/fonts/inter-bold.ttf \
    "https://github.com/rsms/inter/raw/master/docs/font-files/Inter-Bold.ttf" && \
  fc-cache -f -v

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
