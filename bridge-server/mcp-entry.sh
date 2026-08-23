#!/bin/sh
# mcp-entry.sh — точка входа MCP-сервера browser-bridge.
# Сам переходит в свою директорию, поэтому cwd вызывающего (Kimi Code CLI)
# не важен, а в mcp.json не нужны ни cwd, ни env: все пути данных сервер
# считает от корня репозитория (см. REPO_ROOT в src/index.ts).
set -e
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec node --import tsx src/index.ts
