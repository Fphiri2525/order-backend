const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../database');

const JWT_SECRET = 'your_jwt_secret_key'; // change to a strong secret

// ─── REGISTER ────────────────────────────────────────────────────────────────
// POST /api/users/register
router.post('/register', async (req, res) => {
  // Frontend sends: fullname, email, password, role, contact_info
  const { fullname, email, password, role, contact_info } = req.body;

  if (!fullname || !email || !password || !contact_info) {
    return res.status(400).json({
      success: false,
      message: 'All fields are required.',
    });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const allowedRoles = ['admin', 'manager', 'staff', 'customer', 'delivery', 'driver', 'chef', 'waiter', 'cashier'];
    const userRole = allowedRoles.includes(role?.toLowerCase()) ? role.toLowerCase() : 'customer';

    await db.query(
      `INSERT INTO user (fullname, emailaddress, contactnumber, password, role)
       VALUES (?, ?, ?, ?, ?)`,
      [fullname, email, contact_info, hashedPassword, userRole]
    );

    return res.status(201).json({
      success: true,
      message: 'User registered successfully.',
    });

  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        success: false,
        message: 'Email address already in use.',
      });
    }
    console.error(err);
    return res.status(500).json({
      success: false,
      message: 'Server error.',
    });
  }
});

// ─── LOGIN ───────────────────────────────────────────────────────────────────
// POST /api/users/login
router.post('/login', async (req, res) => {
  // Frontend sends: email, password
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      message: 'Email and password are required.',
    });
  }

  try {
    const [rows] = await db.query(
      'SELECT * FROM user WHERE emailaddress = ?',
      [email]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    const user = rows[0];

    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    const token = jwt.sign(
      { id: user.id, email: user.emailaddress, role: user.role },
      JWT_SECRET,
      { expiresIn: '1d' }
    );

    // Response matches what frontend expects: { success, data }
    return res.status(200).json({
      success: true,
      message: 'Login successful.',
      token,
      data: {
        id:            user.id,
        fullname:      user.fullname,
        emailaddress:  user.emailaddress,
        contactnumber: user.contactnumber,
        role:          user.role,
      },
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      message: 'Server error.',
    });
  }
});

module.exports = router;