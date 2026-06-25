require('dotenv').config();
const { sendEmail } = require('./lib/email');

sendEmail({
  to: 'fphiri418@gmail.com',
  subject: 'Test email from my app',
  html: '<p>If you see this, Resend is working!</p>',
})
  .then((data) => console.log('Sent successfully:', data))
  .catch((err) => console.error('Send failed:', err));