import nodemailer from 'nodemailer';
import { SMTP, BRAND, APP_URL } from '../config';

// Derive the transporter type from nodemailer factory to avoid namespace/type issues
type MailTransporter = ReturnType<typeof nodemailer.createTransport>;

let transporter: MailTransporter | null = null;

function getTransporter(): MailTransporter | null {
  if (transporter) return transporter;
  if (!SMTP.host || !SMTP.user || !SMTP.pass) {
    return null;
  }
  transporter = nodemailer.createTransport({
    host: SMTP.host,
    port: SMTP.port,
    secure: SMTP.secure,
    auth: {
      user: SMTP.user,
      pass: SMTP.pass
    }
  });
  return transporter;
}

export async function sendMail(to: string, subject: string, html: string) {
  const t = getTransporter();
  if (!t) {
    // eslint-disable-next-line no-console
    console.warn('[email] SMTP not configured, skipping email to', to, subject);
    return;
  }
  await t.sendMail({ from: SMTP.from, to, subject, html });
}

export async function sendWelcomeWithPassword(to: string, password: string, name?: string) {
  const title = `${SMTP.appName} • Bienvenido/a`;
  const preheader = `Tu cuenta en ${SMTP.appName} está lista.`;
  const body = `
    <p style="margin:0 0 16px;color:${BRAND.textSecondary}">Hola ${name ? `<strong>${name}</strong>` : '👋'},</p>
    <p style="margin:0 0 16px;color:${BRAND.textSecondary}">Tu cuenta ha sido creada correctamente. Aquí tienes tu contraseña temporal:</p>
    <div style="margin:12px 0 20px;padding:12px 16px;border:1px dashed ${BRAND.border};border-radius:8px;background:${BRAND.background};color:${BRAND.textPrimary};font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;">
      <span style="letter-spacing:0.5px;font-weight:600;">${password}</span>
    </div>
    <p style="margin:0 0 16px;color:${BRAND.textSecondary}">Por seguridad, inicia sesión y cambia la contraseña cuanto antes. También te recomendamos habilitar la verificación en dos pasos (2FA).</p>
  `;
  const cta = APP_URL
    ? { label: 'Iniciar sesión', url: APP_URL }
    : undefined;
  const html = renderBaseTemplate({ title, preheader, bodyHtml: body, cta });
  await sendMail(to, title, html);
}

export async function sendPasswordChanged(to: string, newPassword?: string, name?: string) {
  const title = `${SMTP.appName} • Contraseña actualizada`;
  const preheader = 'Tu contraseña fue modificada recientemente.';
  const pwd = newPassword
    ? `<div style="margin:12px 0 20px;padding:12px 16px;border:1px dashed ${BRAND.border};border-radius:8px;background:${BRAND.background};color:${BRAND.textPrimary};font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;"><span style="letter-spacing:0.5px;font-weight:600;">${newPassword}</span></div>`
    : '';
  const body = `
    <p style="margin:0 0 16px;color:${BRAND.textSecondary}">Hola ${name ? `<strong>${name}</strong>` : ''},</p>
    <p style="margin:0 0 16px;color:${BRAND.textSecondary}">Tu contraseña fue cambiada correctamente.</p>
    ${pwd}
    <p style="margin:0 0 16px;color:${BRAND.textSecondary}">Si no fuiste tú, por favor restablece tu contraseña de inmediato.</p>
  `;
  const cta = APP_URL ? { label: 'Ir a la cuenta', url: APP_URL } : undefined;
  const html = renderBaseTemplate({ title, preheader, bodyHtml: body, cta });
  await sendMail(to, title, html);
}

export async function sendFailedLoginAlert(to: string, name?: string, meta?: { ip?: string; userAgent?: string }) {
  const title = `${SMTP.appName} • Intento de inicio fallido`;
  const ip = meta?.ip || 'desconocida';
  const ua = meta?.userAgent || 'desconocido';
  const preheader = 'Detectamos un intento de acceso no exitoso.';
  const body = `
    <p style="margin:0 0 16px;color:${BRAND.textSecondary}">Hola ${name ? `<strong>${name}</strong>` : ''},</p>
    <p style="margin:0 0 16px;color:${BRAND.textSecondary}">Registramos un intento de inicio de sesión que no se completó.</p>
    <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;margin:8px 0 20px;border-collapse:separate;border-spacing:0;">
      <tr>
        <td style="padding:10px 12px;border:1px solid ${BRAND.border};border-right:none;border-radius:8px 0 0 8px;background:${BRAND.surface};color:${BRAND.textSecondary};width:140px;font-weight:600">IP</td>
        <td style="padding:10px 12px;border:1px solid ${BRAND.border};border-radius:0 8px 8px 0;background:${BRAND.surface};color:${BRAND.textPrimary}">${ip}</td>
      </tr>
      <tr>
        <td style="padding:10px 12px;border:1px solid ${BRAND.border};border-right:none;border-radius:8px 0 0 8px;background:${BRAND.surface};color:${BRAND.textSecondary};font-weight:600">Navegador</td>
        <td style="padding:10px 12px;border:1px solid ${BRAND.border};border-radius:0 8px 8px 0;background:${BRAND.surface};color:${BRAND.textPrimary}">${ua}</td>
      </tr>
      <tr>
        <td style="padding:10px 12px;border:1px solid ${BRAND.border};border-right:none;border-radius:8px 0 0 8px;background:${BRAND.surface};color:${BRAND.textSecondary};font-weight:600">Fecha</td>
        <td style="padding:10px 12px;border:1px solid ${BRAND.border};border-radius:0 8px 8px 0;background:${BRAND.surface};color:${BRAND.textPrimary}">${new Date().toLocaleString()}</td>
      </tr>
    </table>
    <p style="margin:0 0 16px;color:${BRAND.textSecondary}">Si no reconoces este intento, te recomendamos cambiar tu contraseña.</p>
  `;
  const cta = APP_URL ? { label: 'Cambiar contraseña', url: APP_URL } : undefined;
  const html = renderBaseTemplate({ title, preheader, bodyHtml: body, cta });
  await sendMail(to, title, html);
}

export async function sendSuccessfulLoginNotice(to: string, name?: string, meta?: { ip?: string; userAgent?: string }) {
  const title = `${SMTP.appName} • Inicio de sesión exitoso`;
  const ip = meta?.ip || 'desconocida';
  const ua = meta?.userAgent || 'desconocido';
  const preheader = 'Tu cuenta se usó para iniciar sesión correctamente.';
  const body = `
    <p style="margin:0 0 16px;color:${BRAND.textSecondary}">Hola ${name ? `<strong>${name}</strong>` : ''},</p>
    <p style="margin:0 0 16px;color:${BRAND.textSecondary}">Se acaba de iniciar sesión correctamente en tu cuenta.</p>
    <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;margin:8px 0 20px;border-collapse:separate;border-spacing:0;">
      <tr>
        <td style="padding:10px 12px;border:1px solid ${BRAND.border};border-right:none;border-radius:8px 0 0 8px;background:${BRAND.surface};color:${BRAND.textSecondary};width:140px;font-weight:600">IP</td>
        <td style="padding:10px 12px;border:1px solid ${BRAND.border};border-radius:0 8px 8px 0;background:${BRAND.surface};color:${BRAND.textPrimary}">${ip}</td>
      </tr>
      <tr>
        <td style="padding:10px 12px;border:1px solid ${BRAND.border};border-right:none;border-radius:8px 0 0 8px;background:${BRAND.surface};color:${BRAND.textSecondary};font-weight:600">Navegador</td>
        <td style="padding:10px 12px;border:1px solid ${BRAND.border};border-radius:0 8px 8px 0;background:${BRAND.surface};color:${BRAND.textPrimary}">${ua}</td>
      </tr>
      <tr>
        <td style="padding:10px 12px;border:1px solid ${BRAND.border};border-right:none;border-radius:8px 0 0 8px;background:${BRAND.surface};color:${BRAND.textSecondary};font-weight:600">Fecha</td>
        <td style="padding:10px 12px;border:1px solid ${BRAND.border};border-radius:0 8px 8px 0;background:${BRAND.surface};color:${BRAND.textPrimary}">${new Date().toLocaleString()}</td>
      </tr>
    </table>
    <p style="margin:0 0 16px;color:${BRAND.textSecondary}">Si no reconoces este inicio, cambia tu contraseña y revisa tus dispositivos.</p>
  `;
  const cta = APP_URL ? { label: 'Gestionar cuenta', url: APP_URL } : undefined;
  const html = renderBaseTemplate({ title, preheader, bodyHtml: body, cta });
  await sendMail(to, title, html);
}

function normalizeRecipients(input: string | string[] | undefined): string[] {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : String(input).split(/[,;]/);
  return raw.map(r => String(r || '').trim()).filter(Boolean);
}

export async function sendContractLinkEmail(params: { to: string | string[]; cc?: string | string[]; contractUrl: string; clientName?: string; installationId?: number | string; planName?: string | null }) {
  const t = getTransporter();
  if (!t) {
    // eslint-disable-next-line no-console
    console.warn('[email] SMTP not configured, skipping contract email to', params.to);
    return;
  }

  const toList = normalizeRecipients(params.to);
  const ccList = normalizeRecipients(params.cc);
  if (!toList.length) {
    // eslint-disable-next-line no-console
    console.warn('[email] No recipients provided for contract email');
    return;
  }

  const title = `${SMTP.appName} • Contrato de servicio`;
  const preheader = 'Tu contrato está listo para revisar y firmar.';
  const friendlyName = params.clientName || 'Cliente';
  const installationLabel = params.installationId ? `ID servicio/instalación: ${params.installationId}` : '';
  const planLabel = params.planName ? `Plan: ${params.planName}` : '';
  const metaLines = [installationLabel, planLabel].filter(Boolean).map(text => `<p style="margin:0 0 8px;color:${BRAND.textSecondary}">${text}</p>`).join('');

  const body = `
    <p style="margin:0 0 16px;color:${BRAND.textSecondary}">Hola ${friendlyName ? `<strong>${friendlyName}</strong>` : ''},</p>
    <p style="margin:0 0 16px;color:${BRAND.textSecondary}">Tu contrato está listo. Puedes revisarlo, firmarlo o descargarlo desde el siguiente enlace seguro:</p>
    <p style="margin:0 0 18px;color:${BRAND.textPrimary}"><a href="${params.contractUrl}" style="color:${BRAND.primary};font-weight:600;word-break:break-all">${params.contractUrl}</a></p>
    ${metaLines || ''}
    <p style="margin:12px 0 0;color:${BRAND.textSecondary}">Si el botón no funciona, copia y pega el enlace en tu navegador.</p>
  `;

  const html = renderBaseTemplate({ title, preheader, bodyHtml: body, cta: { label: 'Abrir contrato', url: params.contractUrl } });

  await t.sendMail({
    from: SMTP.from,
    to: toList.join(', '),
    cc: ccList.length ? ccList.join(', ') : undefined,
    subject: title,
    html
  });
}

export async function verifyTransport(): Promise<{ ok: true } | { ok: false; error: string } | { ok: false; reason: 'not_configured' }> {
  const t = getTransporter();
  if (!t) return { ok: false, reason: 'not_configured' };
  try {
    await t.verify();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function renderBaseTemplate(params: { title: string; preheader?: string; bodyHtml: string; cta?: { label: string; url: string } }) {
  const { title, preheader, bodyHtml, cta } = params;
  const btn = cta
    ? `<tr><td style="padding-top:8px;padding-bottom:4px">
         <a href="${cta.url}" style="display:inline-block;background:${BRAND.accent};color:#fff;text-decoration:none;font-weight:600;padding:12px 18px;border-radius:10px;">${cta.label}</a>
       </td></tr>`
    : '';

  return `<!doctype html>
  <html lang="es">
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${title}</title>
    <style>
      @media (prefers-color-scheme: dark) {
        .surface { background: #0f172a !important; }
        .card { background: #111827 !important; border-color: #1f2937 !important; }
        .text-primary { color: #e5e7eb !important; }
        .text-secondary { color: #9ca3af !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.background};">
    <span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;color:transparent">${preheader || ''}</span>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:${BRAND.background};padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width:640px;max-width:92%;background:${BRAND.surface};border:1px solid ${BRAND.border};border-radius:16px;overflow:hidden;">
            <tr>
              <td style="padding:18px 20px;background:${BRAND.surface};border-bottom:1px solid ${BRAND.border}">
                <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; font-size:18px;font-weight:800;color:${BRAND.primary}">${SMTP.appName}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 22px 10px 22px">
                <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; font-size:18px;line-height:26px;color:${BRAND.textPrimary};font-weight:700;margin-bottom:6px;">${title}</div>
                <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; font-size:14px;line-height:22px;color:${BRAND.textSecondary}">
                  ${bodyHtml}
                </div>
              </td>
            </tr>
            ${btn}
            <tr>
              <td style="padding:18px 22px 28px 22px">
                <div style="height:1px;background:${BRAND.border};margin:12px 0 16px 0"></div>
                <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; font-size:12px;color:${BRAND.textSecondary}">
                  Este mensaje fue enviado por ${SMTP.appName}. Si no esperabas este correo, ignóralo.
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>`;
}
