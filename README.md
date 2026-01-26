## Chat via n8n

- **Resumen:** El backend deja el chat a n8n y expone solo endpoints para formularios y acciones de SmartOLT, más un endpoint opcional para guardar mensajes en la BD.

### Endpoints
- `POST /chat/auth/initiate`: genera formulario de autorización SmartOLT. Body opcional: `{ defaults?, serviceIdOrTerm? }`. Respuesta: `{ ok, message, actions, metadata }`.
- `POST /chat/wan/initiate`: genera formulario WAN estático. Body opcional: campos conocidos (`sn`, `onu_external_id`, `ipv4_address`, etc.). Respuesta: `{ ok, message, actions }`.
- `POST /chat/submitAuth`: ejecuta autorización SmartOLT. Body: `{ collected }` con requeridos: `olt_id`, `sn`, `onu_type`, `zone`, `name`. Opcionales: `pon_type`, `onu_mode`, `board`, `port`, `vlan`, `odb`, `odb_port`, `address_or_comment`, velocidades y datos WAN.
- `POST /chat/applyPendingWan`: aplica WAN estático. Body requeridos: `onu_external_id`, `ipv4_address`. Opcionales: `subnet_mask`, `gateway`, `dns1`, `dns2`.
- `POST /chat/save` (opcional, para n8n): guarda mensajes en BD. Body: `{ userId, role, content?, imageUrl?, actions?, metadata? }`. Autenticación: header `X-N8N-Token` debe coincidir con `N8N_SAVE_TOKEN` o sesión activa.
- `GET /chat/clients/actions?q=<term>`: lista clientes por nombre y devuelve botones de selección. Autenticación: sesión activa o token API.

### Variables de entorno
- `N8N_BASE_URL`: base URL de n8n (opcional si usas `N8N_CHAT_WEBHOOK_URL`).
- `N8N_CHAT_WEBHOOK_URL`: webhook para el workflow de chat.
- `N8N_SAVE_TOKEN`: token compartido para `POST /chat/save`.
- `N8N_API_TOKEN` (o `API_TOKEN`): token para acceso M2M a endpoints no-admin mediante encabezado `X-API-Token` o `X-N8N-Token`.

### Acceso con token API (n8n)
- Envía `X-API-Token: <N8N_API_TOKEN>` (o `X-N8N-Token`) en peticiones a endpoints protegidos por token-o-sesión.
- Los endpoints de admin siguen requiriendo sesión y no aceptan token.

### Ejemplos
```bash
curl -X POST $API/chat/auth/initiate \
	-H 'Content-Type: application/json' \
	-b cookies.txt \
	-d '{"defaults":{"sn":"ZTEGC7E...","name":"Juan Perez","zone":"Zona 1"}}'

curl -X POST $API/chat/submitAuth \
	-H 'Content-Type: application/json' \
	-b cookies.txt \
	-d '{"collected":{"olt_id":1,"pon_type":"gpon","sn":"ZTE...","onu_type":"ZTE-F660V6.0","onu_mode":"Routing","zone":"Zona 1","name":"Juan Perez"}}'

curl -X POST $API/chat/save \
	-H 'Content-Type: application/json' \
	-H "X-N8N-Token: $N8N_SAVE_TOKEN" \
	-d '{"userId":123,"role":"assistant","content":"Hola","actions":[]}'

curl -X POST $API/chat/auth/initiate \
	-H 'Content-Type: application/json' \
	-H "X-API-Token: $N8N_API_TOKEN" \
	-d '{"defaults":{"sn":"ZTEGC7E...","name":"Juan Perez","zone":"Zona 1"}}'
```
# geonet-bot-backend


## SMTP (Emails)

Configura estas variables de entorno para habilitar el envío de correos (registro, cambios de contraseña e intentos fallidos):

- `SMTP_HOST`: host del servidor SMTP
- `SMTP_PORT`: puerto (por defecto 587)
- `SMTP_SECURE`: `true` para TLS explícito (465), `false` para STARTTLS
- `SMTP_USER`: usuario SMTP
- `SMTP_PASS`: contraseña SMTP
- `SMTP_FROM`: dirección remitente (por defecto `no-reply@geonet.local`)
- `APP_NAME`: nombre a mostrar en los correos (por defecto `GeoNet`)
- `APP_URL`: URL pública para CTAs en correos (botón “Iniciar sesión” / “Cambiar contraseña”)
- `BRAND_PRIMARY`, `BRAND_ACCENT`: colores de marca (hex) usados en plantillas

Si no se configuran, el backend omite el envío y registra una advertencia.

