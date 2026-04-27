# Deploy en Vercel

## 1. Crear bucket en Supabase Storage

Antes de desplegar, crea un bucket público en Supabase Storage con este nombre:

- `solicitudes-pdf`

Si prefieres otro nombre, también funciona, pero debes usar el mismo valor en:

- `SUPABASE_STORAGE_BUCKET`

Pasos en Supabase:

1. Entra a `Storage`
2. Clic en `Create bucket`
3. Nombre: `solicitudes-pdf`
4. Activa `Public bucket`

## 2. Variables de entorno en Vercel

Configura estas variables en tu proyecto:

- `COMPANY_NAME`
- `CONTACT_EMAIL`
- `WHATSAPP_NUMBER`
- `WHATSAPP_LABEL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_TABLE`
- `SUPABASE_STORAGE_BUCKET`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `SESSION_SECRET`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

Valores mínimos recomendados:

- `SUPABASE_TABLE=solicitudes`
- `SUPABASE_STORAGE_BUCKET=solicitudes-pdf`

## 3. Importar desde GitHub

1. Entra a Vercel
2. `Add New Project`
3. Importa el repositorio `maquilerosunidos`
4. En `Environment Variables`, pega las variables anteriores
5. Deploy

## 4. Rutas esperadas

- Sitio público: `/`
- Panel admin: `/admin`
- API: `/api/...`

## 5. Nota importante

En producción no uses la contraseña por defecto del panel. Cambia:

- `ADMIN_PASSWORD`
- `SESSION_SECRET`

Y si la `SUPABASE_SERVICE_ROLE_KEY` fue expuesta, rótala antes del deploy final.
