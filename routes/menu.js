const express = require('express');
const router = express.Router();
const db = require('../database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure multer for file upload
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../uploads');
    // Create uploads directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
      console.log('Created uploads directory:', uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const filename = uniqueSuffix + path.extname(file.originalname);
    console.log('Saving file as:', filename);
    cb(null, filename);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);
  
  if (mimetype && extname) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed'));
  }
};

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: fileFilter
});

// GET /api/menu
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query(`SELECT * FROM menu_items ORDER BY created_at DESC`);
    
    // Get server URL for full image paths
    const serverUrl = `${req.protocol}://${req.get('host')}`;
    console.log('Server URL:', serverUrl);
    
    const itemsWithFullUrl = rows.map(item => ({
      id: item.id,
      name: item.name,
      category: item.category,
      price: item.price,
      available: item.available === 1,
      image: item.image ? `${serverUrl}${item.image}` : null,
      created_at: item.created_at
    }));
    
    console.log(`Returning ${itemsWithFullUrl.length} menu items`);
    if (itemsWithFullUrl[0]) {
      console.log('Sample image URL:', itemsWithFullUrl[0].image);
    }
    
    return res.json({ success: true, data: itemsWithFullUrl });
  } catch (err) {
    console.error('MENU FETCH ERROR:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/menu/add - Handle file upload
router.post('/add', upload.single('image'), async (req, res) => {
  try {
    const { foodname, category, price, available } = req.body;
    
    console.log('Received form data:', { foodname, category, price, available });
    console.log('Received file:', req.file);
    
    // Validate required fields
    if (!foodname || !category || !price) {
      return res.status(400).json({
        success: false,
        message: 'foodname, category, and price are required'
      });
    }
    
    // Check if image was uploaded
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Image is required'
      });
    }
    
    // Get the image URL path (relative)
    const imagePath = `/uploads/${req.file.filename}`;
    const availableValue = available !== undefined ? parseInt(available) : 1;
    
    console.log('Saving to DB:', { foodname, category, price, imagePath, availableValue });
    
    // Insert into database
    const query = `INSERT INTO menu_items (name, category, price, image, available) 
                   VALUES (?, ?, ?, ?, ?)`;
    
    const [result] = await db.query(query, [
      foodname, 
      category, 
      price, 
      imagePath, 
      availableValue
    ]);
    
    console.log('Insert successful, ID:', result.insertId);
    
    // Get the full URL for response
    const serverUrl = `${req.protocol}://${req.get('host')}`;
    
    return res.status(201).json({
      success: true,
      message: 'Menu item added successfully',
      data: { 
        id: result.insertId,
        image: `${serverUrl}${imagePath}`
      }
    });
  } catch (err) {
    console.error('MENU ADD ERROR:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;