// ===============================
// IMPORTS
// ===============================
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");

// ===============================
// CONFIG (ENV)
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
// DATABASE CONNECTION (RAILWAY)
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
// ME
// ===============================
app.get("/me", requireAuth, async (req, res, next) => {
  try {
    const [rows] = await db.query(
      "SELECT id, email, role FROM users WHERE id = ?",
      [req.user.id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ===============================
// STORE ORDERS
// ===============================
app.get("/store/orders", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "STORE") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const [stores] = await db.query(
      "SELECT id FROM stores WHERE user_id = ?",
      [req.user.id]
    );

    if (!stores.length) return res.json([]);

    const [rows] = await db.query(
      "SELECT * FROM deliveries WHERE store_id = ? ORDER BY created_at DESC",
      [stores[0].id]
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.post("/store/orders", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "STORE") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { recipient_name, recipient_phone, dropoff_address } = req.body;

    if (!recipient_name || !recipient_phone || !dropoff_address) {
      return res.status(400).json({ message: "Missing delivery fields" });
    }

    const [stores] = await db.query(
      "SELECT id FROM stores WHERE user_id = ?",
      [req.user.id]
    );

    if (!stores.length) {
      return res.status(400).json({ message: "Store not found" });
    }

    await db.query(
      `INSERT INTO deliveries
       (store_id, recipient_name, recipient_phone, dropoff_address, pickup_address, status)
       VALUES (?, ?, ?, ?, 'STORE PICKUP', 'CREATED')`,
      [stores[0].id, recipient_name, recipient_phone, dropoff_address]
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ===============================
// DRIVER ORDERS
// ===============================
app.get("/driver/orders", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "DRIVER") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const [drivers] = await db.query(
      "SELECT id FROM drivers WHERE user_id = ?",
      [req.user.id]
    );

    if (!drivers.length) return res.json([]);

    const [rows] = await db.query(
      `SELECT * FROM deliveries
       WHERE status IN ('AVAILABLE','ACCEPTED','PICKED_UP')
       AND (driver_id IS NULL OR driver_id = ?)`,
      [drivers[0].id]
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.put("/driver/orders/:id/status", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "DRIVER") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { status } = req.body;
    const deliveryId = req.params.id;

    const [drivers] = await db.query(
      "SELECT id FROM drivers WHERE user_id = ?",
      [req.user.id]
    );

    if (!drivers.length) {
      return res.status(400).json({ message: "Driver not found" });
    }

    const driverId = drivers[0].id;

    if (status === "ACCEPTED") {
      await db.query(
        "UPDATE deliveries SET status='ACCEPTED', driver_id=? WHERE id=? AND status='AVAILABLE'",
        [driverId, deliveryId]
      );
    }

    if (status === "PICKED_UP") {
      await db.query(
        "UPDATE deliveries SET status='PICKED_UP' WHERE id=? AND driver_id=?",
        [deliveryId, driverId]
      );
    }

    if (status === "DELIVERED") {
      await db.query(
        "UPDATE deliveries SET status='DELIVERED' WHERE id=? AND driver_id=?",
        [deliveryId, driverId]
      );
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ===============================
// PROOF UPLOAD (TEMP DISABLED)
// ===============================
app.post("/driver/orders/:id/proof", requireAuth, (req, res) => {
  res.status(501).json({
    message: "Proof upload temporarily disabled",
  });
});

// ===============================
// GLOBAL ERROR HANDLER
// ===============================
app.use((err, req, res, next) => {
  console.error("❌ API ERROR:", err);
  res.status(500).json({ message: "Internal server error" });
});

// ===============================
// START SERVER
// ===============================
app.listen(PORT, () => {
  console.log(`✅ FlowerDrop API running on port ${PORT}`);
});
