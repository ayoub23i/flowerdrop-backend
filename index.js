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
// DATABASE CONNECTION (RAILWAY)
// ===============================
const db = mysql.createPool(process.env.MYSQL_URL);

// ===============================
// UPLOADS SETUP (TEMP - RAILWAY FS)
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
// HEALTH (REQUIRED FOR RAILWAY)
// ===============================
app.get("/", (req, res) => {
  res.status(200).json({ message: "Delivery API running" });
});

// ===============================
// LOGIN (SAFE GET)
// ===============================
app.get("/login", (req, res) => {
  res.status(405).json({ message: "Use POST /login" });
});

// ===============================
// LOGIN (POST)
// ===============================
app.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.
