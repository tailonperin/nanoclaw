#!/bin/bash
set -e

# O projeto é montado no container no mesmo caminho absoluto do host.
# Isso é necessário para que os caminhos passados ao Docker (via socket)
# sejam válidos tanto dentro do container quanto no host.
cd "$PWD"

echo "[nanoclaw] Instalando dependências..."
npm install --silent

echo "[nanoclaw] Compilando TypeScript..."
npm run build --silent

echo "[nanoclaw] Iniciando orquestrador..."
exec node dist/index.js
