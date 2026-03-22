# 1. Imagen base ligera de Node.js compatible con ARM64
FROM node:20-alpine

# 2. Establecer el directorio de trabajo dentro del contenedor
WORKDIR /app

# 3. Copiar primero los manifiestos de dependencias
# (Esto optimiza el caché de Podman: si no cambias paquetes, no reinstala todo)
COPY package*.json ./

# 4. Instalar solo las dependencias necesarias para producción
RUN npm install --omit=dev

# 5. Copiar el resto del código (index.js, tus carpetas de SQL, etc.)
COPY . .

# 6. Definir el comando que mantiene vivo el contenedor
CMD ["node", "index.js"]