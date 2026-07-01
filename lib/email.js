const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

async function sendEmail({ to, subject, html }) {
  try {
    await transporter.sendMail({
      from: `"La Crisco Eatery" <${process.env.GMAIL_USER}>`,
      to,
      subject,
      html,
    });
  } catch (err) {
    console.error('sendEmail failed:', err);
    throw err;
  }
}

module.exports = { sendEmail };
