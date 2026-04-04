FROM node:22-slim

# Install system deps for canvas + fonts
RUN apt-get update && apt-get install -y \
  fonts-noto \
  fontconfig \
  wget \
  ca-certificates \
  unzip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Download Inter font from official GitHub release
RUN mkdir -p /app/fonts && \
  wget -q -O /tmp/inter.zip \
    "https://github.com/rsms/inter/releases/download/v4.0/Inter-4.0.zip" && \
  cd /tmp && unzip -q inter.zip && \
  find /tmp -name "Inter-Regular.ttf" -exec cp {} /app/fonts/inter-regular.ttf \; && \
  find /tmp -name "Inter-SemiBold.ttf" -exec cp {} /app/fonts/inter-semibold.ttf \; && \
  find /tmp -name "Inter-Bold.ttf" -exec cp {} /app/fonts/inter-bold.ttf \; && \
  rm -rf /tmp/inter.zip /tmp/Inter* && \
  fc-cache -f -v

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
