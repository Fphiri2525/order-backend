const express = require('express');
const router = express.Router();
const db = require('../database');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;

// ─── GET ALL USERS ────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, fullname, emailaddress, contactnumber, role, created_at FROM user'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET ALL DRIVERS ──────────────────────────────────────
router.get('/drivers', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT 
        id, 
        fullname, 
        emailaddress, 
        contactnumber,
        role,
        created_at
      FROM user 
      WHERE role = 'driver'
      ORDER BY fullname ASC`
    );
    
    // Format the response to match frontend Driver interface
    const formattedDrivers = rows.map(driver => ({
      id: driver.id.toString(),
      name: driver.fullname,
      email: driver.emailaddress,
      phone: driver.contactnumber
    }));
    
    res.json({ 
      success: true, 
      data: formattedDrivers,
      count: formattedDrivers.length
    });
  } catch (err) {
    console.error('Error fetching drivers:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch drivers',
      error: err.message 
    });
  }
});

// ─── GET DRIVER BY ID ─────────────────────────────────────
router.get('/drivers/:id', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT 
        id, 
        fullname, 
        emailaddress, 
        contactnumber,
        role,
        created_at
      FROM user 
      WHERE id = ? AND role = 'driver'`,
      [req.params.id]
    );
    
    if (!rows.length) {
      return res.status(404).json({ 
        success: false, 
        message: 'Driver not found' 
      });
    }
    
    const driver = rows[0];
    const formattedDriver = {
      id: driver.id.toString(),
      name: driver.fullname,
      email: driver.emailaddress,
      phone: driver.contactnumber
    };
    
    res.json({ 
      success: true, 
      data: formattedDriver 
    });
  } catch (err) {
    console.error('Error fetching driver:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch driver',
      error: err.message 
    });
  }
});

// ─── GET USER BY ID ───────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, fullname, emailaddress, contactnumber, role, created_at FROM user WHERE id = ?',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── REGISTER ─────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const fullname      = req.body.fullname;
  const emailaddress  = req.body.emailaddress || req.body.email;
  const contactnumber = req.body.contactnumber || req.body.contact_info;
  const password      = req.body.password;
  const role          = req.body.role || 'customer';

  if (!fullname || !emailaddress || !contactnumber || !password) {
    return res.status(400).json({ success: false, message: 'All fields are required' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    
    const query = 'INSERT INTO user (fullname, emailaddress, contactnumber, password, role) VALUES (?, ?, ?, ?, ?)';
    const values = [fullname, emailaddress, contactnumber, hashedPassword, role.toLowerCase()];
    
    const [result] = await db.query(query, values);
    res.status(201).json({ 
      success: true, 
      message: 'User registered', 
      userId: result.insertId 
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Email already in use' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── LOGIN ────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const emailaddress = req.body.emailaddress || req.body.email;
  const { password } = req.body;

  if (!emailaddress || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  }

  try {
    const [rows] = await db.query(
      'SELECT * FROM user WHERE emailaddress = ?',
      [emailaddress]
    );

    if (!rows.length) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);

    if (!match) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const { password: _, ...userWithoutPassword } = user;
    res.json({ success: true, message: 'Login successful', data: userWithoutPassword });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── UPDATE USER ──────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const fullname      = req.body.fullname;
  const emailaddress  = req.body.emailaddress || req.body.email;
  const contactnumber = req.body.contactnumber || req.body.contact_info;
  const role          = req.body.role;
  const password      = req.body.password;

  try {
    let query = 'UPDATE user SET fullname=?, emailaddress=?, contactnumber=?, role=?';
    const values = [fullname, emailaddress, contactnumber, role];
    
    if (password) {
      const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
      query += ', password=?';
      values.push(hashedPassword);
    }
    
    query += ' WHERE id=?';
    values.push(req.params.id);
    
    await db.query(query, values);
    res.json({ success: true, message: 'User updated' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Email already in use' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── DELETE USER ──────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const [result] = await db.query('DELETE FROM user WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.json({ success: true, message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;