# Use a versão LTS do Node.js como base
FROM node:22-alpine
# ENV TZ="America/Sao_Paulo"

# Defina a pasta de trabalho
WORKDIR /usr/src/app

# Copie apenas os arquivos necessários para instalar as dependências
COPY package.json pnpm-lock.yaml ./

# Instale o gerenciador de pacotes pnpm
RUN npm install -g pnpm

# Copie os arquivos do projeto
COPY . .

# # Instale as dependências do projeto
RUN pnpm i

# Gere os tipos do Prisma
RUN npx prisma generate

# Construa a aplicação
RUN npx NODE_OPTIONS=--max-old-space-size=4096 nest build

# Execute a aplicação
CMD ["node", "dist/main"]
