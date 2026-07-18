import nodemailer from "nodemailer";

// Email transport is optional. If SMTP isn't configured, we log the magic link
// to the server log instead (handy for bootstrapping — grab your first sign-in
// link from the add-on Log tab).
const host = process.env.SMTP_HOST;
const port = Number(process.env.SMTP_PORT || 587);
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASSWORD;
const from = process.env.SMTP_FROM || user || "wardrobe@localhost";

const transport =
  host && user && pass
    ? nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      })
    : null;

export function emailConfigured(): boolean {
  return transport !== null;
}

export async function sendMagicLink(to: string, link: string): Promise<void> {
  if (!transport) {
    console.log(
      `\n[magic-link] Email not configured. Sign-in link for ${to}:\n${link}\n`
    );
    return;
  }
  await transport.sendMail({
    from,
    to,
    subject: "Your Digital Wardrobe sign-in link",
    text: `Tap to sign in to Digital Wardrobe:\n\n${link}\n\nThis link expires in 15 minutes. If you didn't request it, ignore this email.`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto">
        <h2>👗 Digital Wardrobe</h2>
        <p>Tap the button to sign in:</p>
        <p>
          <a href="${link}" style="display:inline-block;background:#9a63ff;color:#fff;
             padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">
            Sign in
          </a>
        </p>
        <p style="color:#666;font-size:13px">This link expires in 15 minutes.
        If you didn't request it, you can ignore this email.</p>
      </div>`,
  });
}
