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
    if (!auth) return res.status(401).json({ message: "Missing token" });

    if (!JWT_SECRET) {
      return res.status(500).json({ message: "JWT_SECRET not set" });
    }

    const token = auth.split(" ")[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
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
  return rows.length ? rows[0].id : null;
}

async function getDriverId(userId) {
  const [rows] = await db.query(
    "SELECT id FROM drivers WHERE user_id = ?",
    [userId]
  );
  return rows.length ? rows[0].id : null;
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

    if (!rows.length || password !== rows[0].password_hash?.trim()) {
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

// ===============================
// ME
// ===============================
app.get("/me", requireAuth, async (req, res, next) => {
  try {
    const [rows] = await db.query(
      "SELECT id, email, role FROM users WHERE id = ?",
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ message: "User not found" });
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

    const storeId = await getStoreId(req.user.id);
    if (!storeId) return res.status(400).json({ message: "Store not found" });

    const [rows] = await db.query(
      "SELECT * FROM deliveries WHERE store_id = ? ORDER BY created_at DESC",
      [storeId]
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

    const storeId = await getStoreId(req.user.id);
    if (!storeId) return res.status(400).json({ message: "Store not found" });

    await db.query(
      `INSERT INTO deliveries
       (store_id, recipient_name, recipient_phone, dropoff_address, pickup_address, status)
       VALUES (?, ?, ?, ?, 'STORE PICKUP', 'CREATED')`,
      [storeId, recipient_name, recipient_phone, dropoff_address]
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ===============================
// STORE UPDATE STATUS
// ===============================
app.put("/store/orders/:id/status", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "STORE") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { status } = req.body || {};
    const allowed = ["PREPARING", "READY_FOR_PICKUP"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: "Invalid store status" });
    }

    const storeId = await getStoreId(req.user.id);
    if (!storeId) return res.status(400).json({ message: "Store not found" });

    const [current] = await db.query(
      "SELECT status FROM deliveries WHERE id = ? AND store_id = ?",
      [req.params.id, storeId]
    );
    if (!current.length) {
      return res.status(404).json({ message: "Delivery not found" });
    }

    const cur = current[0].status;
    if (
      (cur === "CREATED" && status !== "PREPARING") ||
      (cur === "PREPARING" && status !== "READY_FOR_PICKUP")
    ) {
      return res.status(400).json({
        message: `Invalid transition from ${cur} to ${status}`,
      });
    }

    await db.query(
      "UPDATE deliveries SET status = ? WHERE id = ? AND store_id = ?",
      [status, req.params.id, storeId]
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ===============================
// STORE DELETE DELIVERY
// ===============================
app.delete("/store/orders/:id", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "STORE") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const storeId = await getStoreId(req.user.id);
    if (!storeId) return res.status(400).json({ message: "Store not found" });

    const [result] = await db.query(
      `DELETE FROM deliveries
       WHERE id = ? AND store_id = ?
       AND status IN ('CREATED','PREPARING')`,
      [req.params.id, storeId]
    );

    if (result.affectedRows === 0) {
      return res.status(400).json({
        message: "Cannot delete delivery at this stage",
      });
    }

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

    const driverId = await getDriverId(req.user.id);
    if (!driverId) return res.status(400).json({ message: "Driver not found" });

    const [rows] = await db.query(
      `SELECT * FROM deliveries
       WHERE status IN ('READY_FOR_PICKUP','ACCEPTED','PICKED_UP')
       AND (driver_id IS NULL OR driver_id = ?)`,
      [driverId]
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ===============================
// DRIVER UPDATE STATUS
// ===============================
app.put("/driver/orders/:id/status", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "DRIVER") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { status } = req.body || {};
    const allowed = ["ACCEPTED", "PICKED_UP", "DELIVERED"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: "Invalid driver status" });
    }

    const driverId = await getDriverId(req.user.id);
    if (!driverId) return res.status(400).json({ message: "Driver not found" });

    const [cur] = await db.query(
      "SELECT status, driver_id FROM deliveries WHERE id = ?",
      [req.params.id]
    );
    if (!cur.length) return res.status(404).json({ message: "Delivery not found" });

    const currentStatus = cur[0].status;
    const currentDriver = cur[0].driver_id;

    if (status === "ACCEPTED") {
      if (currentStatus !== "READY_FOR_PICKUP") {
        return res.status(400).json({ message: "Not ready for pickup" });
      }

      await db.query(
        "UPDATE deliveries SET status='ACCEPTED', driver_id=? WHERE id=?",
        [driverId, req.params.id]
      );
      return res.json({ success: true });
    }

    if (currentDriver !== driverId) {
      return res.status(403).json({ message: "Not your delivery" });
    }

    if (status === "PICKED_UP" && currentStatus === "ACCEPTED") {
      await db.query(
        "UPDATE deliveries SET status='PICKED_UP' WHERE id=? AND driver_id=?",
        [req.params.id, driverId]
      );
      return res.json({ success: true });
    }

    if (status === "DELIVERED" && currentStatus === "PICKED_UP") {
      await db.query(
        "UPDATE deliveries SET status='DELIVERED' WHERE id=? AND driver_id=?",
        [req.params.id, driverId]
      );
      return res.json({ success: true });
    }

    res.status(400).json({ message: "Invalid status transition" });
  } catch (err) {
    next(err);
  }
});

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
