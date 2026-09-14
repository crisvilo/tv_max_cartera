# Grupo TV MAX - Migración Fase 1

## 1. Neon
Ejecuta `sql/schema_neon.sql` en Neon.

## 2. Cloudflare Worker
```bash
cd worker
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Configura `DATABASE_URL` como secreto en Cloudflare antes de desplegar.

## Importante sobre usuarios
Supabase Auth no permite exportar las contraseñas originales. Los usuarios deberán recibir una contraseña nueva o pasar por un proceso de restablecimiento. Esta primera fase usa hashes PBKDF2 compatibles con Web Crypto de Cloudflare Workers.
