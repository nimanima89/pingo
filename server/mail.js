import nodemailer from 'nodemailer';

const {SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM} = process.env;

const transport = SMTP_HOST ? nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT || 587),
  secure: Number(SMTP_PORT) === 465,
  auth: SMTP_USER ? {user: SMTP_USER, pass: SMTP_PASS} : undefined
}) : null;

export const mailEnabled = Boolean(transport);

// Without SMTP credentials the code is logged instead, so sign-up still works locally.
export async function sendVerificationCode(email, code) {
  if(!transport) {
    console.log(`[pingo:mail] verification code for ${email}: ${code}`);
    return {delivered: false, code};
  }

  await transport.sendMail({
    from: SMTP_FROM || 'Pingo <no-reply@pingo.local>',
    to: email,
    subject: 'Your Pingo verification code',
    text: `Your Pingo verification code is ${code}. It expires in 15 minutes.`,
    html: `<p>Your Pingo verification code is <b style="font-size:20px">${code}</b>.</p><p>It expires in 15 minutes.</p>`
  });

  return {delivered: true};
}
