FROM node:20-alpine
WORKDIR /app

COPY package*.json ./

# Instala todas las dependencias, incluyendo devDependencies
RUN npm install --include=dev

COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev"]
