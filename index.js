// ===============================
// IMPORTS
// ===============================
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");

// ===============================
// CONFIG
// ===============================
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

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
// AUTH MIDDLEWARE
// ===============================
function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ message: "Missing token" });

    if (!JWT_SECRET) {
      return res.status(500).json({ message: "JWT_SECRET not set" });
    }

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
  const [rows] = await db.query("SELECT id FROM stores WHERE user_id = ?", [
    userId,
  ]);
  return rows[0]?.id ?? null;
}

async function getDriverId(userId) {
  const [rows] = await db.query("SELECT id FROM drivers WHERE user_id = ?", [
    userId,
  ]);
  return rows[0]?.id ?? null;
}

// ===============================
// HEALTH
// ===============================
app.get("/", (req, res) => {
  res.json({ message: "FlowerDrop API running" });
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

    if (!rows.length || password !== (rows[0].password_hash || "").trim()) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: rows[0].id, role: rows[0].role },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ token, role: rows[0].role });
  } catch (err) {
    next(err);
  }
});

// =======================================================
// STORE
// =======================================================

// ===============================
// STORE CREATE DELIVERY (ALIGNED)
// ===============================
app.post("/store/orders", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "STORE") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const {
      recipient_name,
      recipient_phone,
      dropoff_address,
      tag_number = null,
      deliver_before = null,
      deliver_after = null,
      buzz_code = null,
      unit = null,
      note = null,
    } = req.body || {};

    if (!recipient_name || !recipient_phone || !dropoff_address) {
      return res.status(400).json({ message: "Missing delivery fields" });
    }

    const storeId = await getStoreId(req.user.id);
    if (!storeId) return res.status(400).json({ message: "Store not found" });

    const [result] = await db.query(
      `
      INSERT INTO deliveries
      (store_id, recipient_name, recipient_phone, dropoff_address, pickup_address,
       tag_number, deliver_before, deliver_after, status)
      VALUES (?, ?, ?, ?, 'STORE PICKUP', ?, ?, ?, 'CREATED')
      `,
      [
        storeId,
        recipient_name,
        recipient_phone,
        dropoff_address,
        tag_number,
        deliver_before,
        deliver_after,
      ]
    );

    const deliveryId = result.insertId;

    if (buzz_code || unit || note) {
      await db.query(
        `
        INSERT INTO delivery_instructions
        (delivery_id, buzz_code, unit, note)
        VALUES (?, ?, ?, ?)
        `,
        [deliveryId, buzz_code, unit, note]
      );
    }

    res.json({ success: true, delivery_id: deliveryId });
  } catch (err) {
    next(err);
  }
});

// =======================================================
// DRIVER / OTHER ROUTES UNCHANGED
// =======================================================

// ===============================
// GLOBAL ERROR HANDLER
// ===============================
app.use((err, req, res, next) => {
  console.error("❌ API ERROR:", err);
  res.status(500).json({ message: err.message || "Internal server error" });
});

// ===============================
// START SERVER
// ===============================
app.listen(PORT, () => {
  console.log(`✅ FlowerDrop API running on port ${PORT}`);
});
