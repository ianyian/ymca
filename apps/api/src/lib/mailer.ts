import net from "node:net";
import { getEnv } from "../config/env.js";

/** Very small SMTP client — no dependencies required. */
async function sendSmtp(opts: {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(opts.port, opts.host);
    const lines: string[] = [];
    let step = 0;

    function send(line: string) {
      sock.write(line + "\r\n");
    }

    const body = [
      `From: ${opts.from}`,
      `To: ${opts.to}`,
      `Subject: ${opts.subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=utf-8`,
      ``,
      opts.html,
    ].join("\r\n");

    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      lines.push(chunk);
      const code = parseInt(chunk.slice(0, 3));
      if (step === 0 && code === 220) {
        step = 1;
        send(`EHLO ymca`);
      } else if (step === 1 && code === 250) {
        if (opts.user) {
          step = 2;
          send(`AUTH LOGIN`);
        } else {
          step = 3;
          send(`MAIL FROM:<${opts.from}>`);
        }
      } else if (step === 2 && code === 334) {
        step = 2.5;
        send(Buffer.from(opts.user ?? "").toString("base64"));
      } else if (step === 2.5 && code === 334) {
        step = 3;
        send(Buffer.from(opts.pass ?? "").toString("base64"));
      } else if (step === 3 && code === 235) {
        step = 4;
        send(`MAIL FROM:<${opts.from}>`);
      } else if (step === 4 && code === 250) {
        step = 5;
        send(`RCPT TO:<${opts.to}>`);
      } else if (step === 5 && code === 250) {
        step = 6;
        send(`DATA`);
      } else if (step === 6 && code === 354) {
        step = 7;
        sock.write(body + "\r\n.\r\n");
      } else if (step === 7 && code === 250) {
        step = 8;
        send(`QUIT`);
      } else if (step === 8 && code === 221) {
        sock.destroy();
        resolve();
      } else if (code >= 400) {
        sock.destroy();
        reject(new Error(`SMTP error ${code}: ${chunk.trim()}`));
      }
    });

    sock.on("error", reject);
    sock.on("timeout", () => {
      sock.destroy();
      reject(new Error("SMTP timeout"));
    });
    sock.setTimeout(10_000);
  });
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

  // If SMTP is configured, send real email
  if (env.SMTP_HOST) {
    await sendSmtp({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.SMTP_FROM,
      to: opts.to,
      subject: "Reset your YMCA Workspace password",
      html,
    });
    return { sent: true };
  }

  // Dev mode — log link to console and return it in response
  console.log(
    `\n[DEV] Password reset link for ${opts.to}:\n  ${opts.resetUrl}\n`,
  );
  return { sent: false, devLink: opts.resetUrl };
}
