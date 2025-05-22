# Usar una imagen base de Node.js
FROM node:18-alpine

# Instalar dependencias necesarias para Puppeteer
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# Crear directorio de trabajo
WORKDIR /app

# Copiar package.json y package-lock.json (si existe)
COPY package*.json ./

# Instalar dependencias
RUN npm install

# Copiar el resto del código
COPY . .

# Crear directorio para persistir datos
RUN mkdir -p /app/data

# Configurar Puppeteer para usar Chromium instalado
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Exponer el puerto
EXPOSE 4000

# Comando para ejecutar la aplicación
CMD ["node", "index.js"]