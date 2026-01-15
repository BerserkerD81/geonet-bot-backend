FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

# Por defecto arrancamos en modo producción; docker-compose.dev.yml y
# docker-compose.prod.yml pueden sobreescribir el comando.
CMD ["npm", "run", "start"]