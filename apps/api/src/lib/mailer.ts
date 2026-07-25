import nodemailer from "nodemailer";
import { getEnv } from "../config/env.js";

// A single lazily-created transport, reused across requests. nodemailer handles
// the parts a hand-rolled SMTP client gets wrong: STARTTLS on 587, implicit TLS
// on 465, multiline greetings, AUTH negotiation, and header/body encoding.
let transport: nodemailer.Transporter | null = null;

function getTransport(): nodemailer.Transporter | null {
  const env = getEnv();
  if (!env.SMTP_HOST) return null;
  if (transport) return transport;

  transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // Port 465 uses implicit TLS; 587/25 start plaintext and upgrade via STARTTLS.
    secure: env.SMTP_PORT === 465,
    ...(env.SMTP_USER
      ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } }
      : {}),
  });
  return transport;
}

export async function sendPasswordResetEmail(opts: {
  to: string;
  resetUrl: string;
  appUrl: string;
}): Promise<{ sent: boolean; devLink?: string }> {
  const env = getEnv();

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body{font-family:system-ui,sans-serif;background:#f5f0e8;margin:0;padding:32px}
  .card{max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:36px;box-shadow:0 2px 16px rgba(0,0,0,.08)}
  h1{font-size:20px;color:#37352f;margin:0 0 8px}
  p{color:#6b6b6b;font-size:14px;line-height:1.6;margin:8px 0}
  .btn{display:inline-block;margin:20px 0;padding:12px 28px;background:#8b6f47;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600}
  .link{font-size:12px;color:#aaa;word-break:break-all;margin-top:16px}
  .footer{font-size:11px;color:#bbb;margin-top:24px;border-top:1px solid #eee;padding-top:16px}
</style></head>
<body>
  <div class="card">
    <h1>Reset your password</h1>
    <p>We received a request to reset your YMCA Workspace password. Click the button below to choose a new password.</p>
    <a class="btn" href="${opts.resetUrl}">Reset password</a>
    <p class="link">Or copy this link: ${opts.resetUrl}</p>
    <p>This link expires in <strong>1 hour</strong>. If you didn't request this, you can safely ignore this email.</p>
    <div class="footer">YMCA Workspace &mdash; <a href="${opts.appUrl}" style="color:#8b6f47">${opts.appUrl}</a></div>
  </div>
</body>
</html>`;

  const mailer = getTransport();

  // No SMTP configured → dev mode: log the link and return it so the UI can show it.
  if (!mailer) {
    console.log(
      `\n[DEV] Password reset link for ${opts.to}:\n  ${opts.resetUrl}\n`,
    );
    return { sent: false, devLink: opts.resetUrl };
  }

  await mailer.sendMail({
    from: env.SMTP_FROM,
    to: opts.to,
    subject: "Reset your YMCA Workspace password",
    html,
  });
  return { sent: true };
}
