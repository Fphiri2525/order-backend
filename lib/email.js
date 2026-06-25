// lib/email.js
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendEmail({ to, subject, html }) {
  try {
    const { data, error } = await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to,
      subject,
      html,
    });

    if (error) {
      console.error('Resend error:', error);
      throw new Error(error.message || 'Failed to send email');
    }

    return data;
  } catch (err) {
    console.error('sendEmail failed:', err);
    throw err;
  }
}

module.exports = { sendEmail };