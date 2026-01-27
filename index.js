// ===============================
// IMPORTS
// ===============================
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");
const path = require("path");
const fs = require("fs");

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
// LOGIN (UNCHANGED)
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

// STORE → VIEW ORDERS (UNCHANGED + EXTENDED)
app.get("/store/orders", requireAuth, async (req, res) => {
  if (req.user.role !== "STORE") {
    return res.status(403).json({ message: "Forbidden" });
  }

  const storeId = await getStoreId(req.user.id);
  const [deliveries] = await db.query(
    "SELECT * FROM deliveries WHERE store_id = ? ORDER BY created_at DESC",
    [storeId]
  );

  for (const d of deliveries) {
    // proofs (STRING URLs – backward compatible)
    const [proofs] = await db.query(
      "SELECT image_url FROM delivery_proofs WHERE delivery_id = ?",
      [d.id]
    );
    d.proof_images = proofs.map(p => `${BASE_URL}${p.image_url}`);

    // driver info
    if (d.driver_id) {
      const [rows] = await db.query(
        `
        SELECT dr.id, u.name, u.phone
        FROM drivers dr
        JOIN users u ON u.id = dr.user_id
        WHERE dr.id = ?
        `,
        [d.driver_id]
      );
      d.driver = rows.length ? rows[0] : null;
    } else {
      d.driver = null;
    }
  }

  res.json(deliveries);
});

// STORE → CREATE DELIVERY (RESTORED)
app.post("/store/orders", requireAuth, async (req, res) => {
  if (req.user.role !== "STORE") {
    return res.status(403).json({ message: "Forbidden" });
  }

  const { recipient_name, recipient_phone, dropoff_address } = req.body;
  const storeId = await getStoreId(req.user.id);

  await db.query(
    `
    INSERT INTO deliveries
    (store_id, recipient_name, recipient_phone, dropoff_address, pickup_address, status)
    VALUES (?, ?, ?, ?, 'STORE PICKUP', 'CREATED')
    `,
    [storeId, recipient_name, recipient_phone, dropoff_address]
  );

  res.json({ success: true });
});

// STORE → STATUS SWITCH (CREATED → PREPARING → READY_FOR_PICKUP)
app.put("/store/orders/:id/status", requireAuth, async (req, res) => {
  if (req.user.role !== "STORE") {
    return res.status(403).json({ message: "Forbidden" });
  }

  const { status } = req.body;
  const storeId = await getStoreId(req.user.id);

  const [cur] = await db.query(
    "SELECT status FROM deliveries WHERE id = ? AND store_id = ?",
    [req.params.id, storeId]
  );

  const current = cur[0]?.status;
  if (
    (current === "CREATED" && status !== "PREPARING") ||
    (current === "PREPARING" && status !== "READY_FOR_PICKUP")
  ) {
    return res.status(400).json({ message: "Invalid transition" });
  }

  await db.query(
    "UPDATE deliveries SET status = ? WHERE id = ?",
    [status, req.params.id]
  );

  res.json({ success: true });
});

// =======================================================
// DRIVER
// =======================================================

// DRIVER → AVAILABLE + ASSIGNED JOBS (EXTENDED)
app.get("/driver/orders", requireAuth, async (req, res) => {
  if (req.user.role !== "DRIVER") {
    return res.status(403).json({ message: "Forbidden" });
  }

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

  for (const d of deliveries) {
    const [rows] = await db.query(
      `
      SELECT s.id, u.name, u.phone
      FROM stores s
      JOIN users u ON u.id = s.user_id
      WHERE s.id = ?
      `,
      [d.store_id]
    );
    d.store = rows.length ? rows[0] : null;
  }

  res.json(deliveries);
});

// DRIVER → UPDATE STATUS
app.put("/driver/orders/:id/status", requireAuth, async (req, res) => {
  if (req.user.role !== "DRIVER") {
    return res.status(403).json({ message: "Forbidden" });
  }

  const { status } = req.body;
  const driverId = await getDriverId(req.user.id);

  if (status === "ACCEPTED") {
    await db.query(
      "UPDATE deliveries SET status='ACCEPTED', driver_id=? WHERE id=? AND status='READY_FOR_PICKUP'",
      [driverId, req.params.id]
    );
  }

  if (status === "PICKED_UP") {
    await db.query(
      "UPDATE deliveries SET status='PICKED_UP' WHERE id=? AND driver_id=?",
      [req.params.id, driverId]
    );
  }

  if (status === "DELIVERED") {
    await db.query(
      "UPDATE deliveries SET status='DELIVERED' WHERE id=? AND driver_id=?",
      [req.params.id, driverId]
    );
  }

  res.json({ success: true });
});

// =======================================================
// PROOF DOWNLOAD (ADDITIVE)
// =======================================================
app.get("/download/proof/:id", requireAuth, async (req, res) => {
  const [rows] = await db.query(
    "SELECT image_url FROM delivery_proofs WHERE id = ?",
    [req.params.id]
  );
  const filePath = path.join(__dirname, rows[0].image_url);
  res.download(filePath);
});

app.use("/uploads", express.static(uploadDir));

// ===============================
// START SERVER
// ===============================
app.listen(PORT, () => {
  console.log(`✅ FlowerDrop API running on port ${PORT}`);
});
