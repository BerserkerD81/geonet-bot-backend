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

