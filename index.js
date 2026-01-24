// ===============================
// IMPORTS
// ===============================
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// ===============================
// CONFIG
// ===============================
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "flowerdrop_secret";

// ===============================
// APP SETUP
// ===============================
const app = express();
app.use(cors());
app.use(express.json());

// ===============================
// DATABASE (RAILWAY)
// ===============================
const db = mysql.createPool(process.env.MYSQL_URL);

// ===============================
// UPLOADS (TEMP FILESYSTEM)
// ===============================
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || ".jpg");
      cb(null, `proof-${Date.now()}${ext}`);
    },
  }),
});

// ===============================
// AUTH MIDDLEWARE
// ===============================
function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth) {
      return res.status(401).json({ message: "Missing token" });
    }

    const token = auth.split(" ")[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
}

// ===============================
// HEALTH CHECK
// ===============================
app.get("/", (req, res) => {
  res.status(200).json({ message: "Delivery API running" });
});

// ===============================
// LOGIN
// ===============================
app.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ message: "Missing credentials" });
    }

    const [rows] = await db.query(
      "SELECT id, role, password_hash FROM users WHERE email = ?",
      [email]
    );

    if (!rows.length) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const user = rows[0];

    if (password !== user.password_hash?.trim()) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ token, role: user.role });
  } catch (err) {
    next(err);
  }
});

// ===============================
// TEST DB
// ===============================
app.get("/test-db", async (req, res, next) => {
  try {
    const [rows] = await db.query("SHOW TABLES");
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ===============================
// STATIC UPLOADS
// ===============================
app.use("/uploads", express.static(uploadDir));

// ===============================
// ERROR HANDLER
// ===============================
app.use((err, req, res, next) => {
  console.error("❌ API ERROR:", err);
  res.status(500).json({
    message: "Internal server error",
    error: err.message,
  });
});

// ===============================
// START SERVER
// ===============================
app.listen(PORT, () => {
  console.log(`✅ API running on port ${PORT}`);
});
