// ===============================
// IMPORTS
// ===============================
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

// ===============================
// CONFIG
// ===============================
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ===============================
// APP SETUP
// ===============================
const app = express();
app.use(cors());
app.use(express.json());

// ===============================
// DB CONNECTION
// ===============================
const db = mysql.createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: process.env.MYSQLPORT,
  waitForConnections: true,
  connectionLimit: 10,
});

// ===============================
// UPLOADS
// ===============================
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

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
// AUTH
// ===============================
function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ message: "Missing token" });
    const token = auth.split(" ")[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
}

// ===============================
// HELPERS
// ===============================
async function getStoreId(userId) {
  const [rows] = await db.query(
    "SELECT id FROM stores WHERE user_id = ?",
    [userId]
  );
  return rows[0]?.id ?? null;
}

async function getDriverId(userId) {
  const [rows] = await db.query(
    "SELECT id FROM drivers WHERE user_id = ?",
    [userId]
  );
  return rows[0]?.id ?? null;
}

// ===============================
// LOGIN
// ===============================
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const [rows] = await db.query(
    "SELECT id, role, password_hash FROM users WHERE email = ?",
    [email]
  );

  if (!rows.length || password !== rows[0].password_hash) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  const token = jwt.sign(
    { id: rows[0].id, role: rows[0].role },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({ token, role: rows[0].role });
});

// =======================================================
// STORE
// =======================================================
app.get("/store/orders", requireAuth, async (req, res) => {
  if (req.user.role !== "STORE") return res.status(403).json({ message: "Forbidden" });

  const storeId = await getStoreId(req.user.id);
  const [deliveries] = await db.query(
    "SELECT * FROM deliveries WHERE store_id = ? ORDER BY created_at DESC",
    [storeId]
  );

  for (const d of deliveries) {
    const [proofs] = await db.query(
      "SELECT image_url FROM delivery_proofs WHERE delivery_id = ?",
      [d.id]
    );
    d.proof_images = proofs.map(p => `${BASE_URL}${p.image_url}`);
  }

  res.json(deliveries);
});

// =======================================================
// DRIVER
// =======================================================
app.get("/driver/orders", requireAuth, async (req, res) => {
  if (req.user.role !== "DRIVER") return res.status(403).json({ message: "Forbidden" });

  const driverId = await getDriverId(req.user.id);
  const [deliveries] = await db.query(
    `
    SELECT *
    FROM deliveries
    WHERE status IN ('READY_FOR_PICKUP','ACCEPTED','PICKED_UP')
      AND (driver_id IS NULL OR driver_id = ?)
    ORDER BY created_at DESC
    `,
    [driverId]
  );

  res.json(deliveries);
});

// =======================================================
// DRIVER → UPLOAD PROOF (REAL FILE UPLOAD)
// =======================================================
app.post(
  "/driver/orders/:id/proof",
  requireAuth,
  upload.single("photo"),
  async (req, res) => {
    if (req.user.role !== "DRIVER") {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const driverId = await getDriverId(req.user.id);

    const [eligible] = await db.query(
      "SELECT id FROM deliveries WHERE id=? AND driver_id=? AND status='PICKED_UP'",
      [req.params.id, driverId]
    );

    if (!eligible.length) {
      return res.status(400).json({ message: "Delivery not eligible" });
    }

    const imageUrl = `/uploads/${req.file.filename}`;

    await db.query(
      `
      INSERT INTO delivery_proofs (delivery_id, image_url, uploaded_by)
      VALUES (?, ?, 'DRIVER')
      `,
      [req.params.id, imageUrl]
    );

    res.json({
      success: true,
      image_url: `${BASE_URL}${imageUrl}`,
    });
  }
);

// ===============================
// STATIC UPLOADS
// ===============================
app.use("/uploads", express.static(uploadDir));

// ===============================
// START SERVER
// ===============================
app.listen(PORT, () => {
  console.log(`✅ FlowerDrop API running on port ${PORT}`);
});
