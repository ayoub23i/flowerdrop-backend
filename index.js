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
      "SELECT id, email, name, phone, role FROM users WHERE id = ?",
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ message: "User not found" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ===============================
// STORE ORDERS (WITH DRIVER INFO)
// ===============================
app.get("/store/orders", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "STORE") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const storeId = await getStoreId(req.user.id);
    if (!storeId) return res.status(400).json({ message: "Store not found" });

    const [rows] = await db.query(
      `
      SELECT
        d.*,

        JSON_ARRAYAGG(
          CASE WHEN p.image_url IS NOT NULL THEN p.image_url END
        ) AS proof_images,

        dr.id AS driver_id,
        u.name AS driver_name,
        u.phone AS driver_phone

      FROM deliveries d

      LEFT JOIN delivery_proofs p
        ON p.delivery_id = d.id

      LEFT JOIN drivers dr
        ON dr.id = d.driver_id

      LEFT JOIN users u
        ON u.id = dr.user_id

      WHERE d.store_id = ?
      GROUP BY d.id
      ORDER BY d.created_at DESC
      `,
      [storeId]
    );

    const result = rows.map((r) => ({
      ...r,
      driver: r.driver_id
        ? {
            id: r.driver_id,
            name: r.driver_name,
            phone: r.driver_phone,
          }
        : null,
    }));

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ===============================
// STORE CREATE DELIVERY
// ===============================
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
// DRIVER ORDERS (WITH STORE INFO)
// ===============================
app.get("/driver/orders", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "DRIVER") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const driverId = await getDriverId(req.user.id);
    if (!driverId) return res.status(400).json({ message: "Driver not found" });

    const [rows] = await db.query(
      `
      SELECT
        d.*,
        s.id AS store_id,
        s.name AS store_name
      FROM deliveries d
      JOIN stores s ON s.id = d.store_id
      WHERE d.driver_id = ?
      `,
      [driverId]
    );

    const result = rows.map((r) => ({
      ...r,
      store: {
        id: r.store_id,
        name: r.store_name,
      },
    }));

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ===============================
// DRIVER UPLOAD PROOF (MAX 2)
// ===============================
app.post("/driver/orders/:id/proof", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "DRIVER") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { image_url } = req.body;
    if (!image_url) {
      return res.status(400).json({ message: "image_url is required" });
    }

    const [[countRow]] = await db.query(
      `
      SELECT COUNT(*) AS count
      FROM delivery_proofs
      WHERE delivery_id = ?
        AND uploaded_by = 'DRIVER'
      `,
      [req.params.id]
    );

    if (countRow.count >= 2) {
      return res.status(400).json({
        message: "Maximum of 2 proof photos allowed",
      });
    }

    await db.query(
      `INSERT INTO delivery_proofs (delivery_id, image_url, uploaded_by, created_at)
       VALUES (?, ?, 'DRIVER', NOW())`,
      [req.params.id, image_url]
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ===============================
// DRIVER UPDATE STATUS (MIN 2)
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

    if (status === "DELIVERED") {
      const [[row]] = await db.query(
        `
        SELECT COUNT(*) AS count
        FROM delivery_proofs
        WHERE delivery_id = ?
          AND uploaded_by = 'DRIVER'
        `,
        [req.params.id]
      );

      if (row.count < 2) {
        return res.status(400).json({
          message: "2 proof photos are required before delivery",
        });
      }
    }

    await db.query(
      "UPDATE deliveries SET status = ? WHERE id = ?",
      [status, req.params.id]
    );

    res.json({ success: true });
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
