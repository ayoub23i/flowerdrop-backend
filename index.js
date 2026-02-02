// ===============================
// IMPORTS
// ===============================
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");
const admin = require("firebase-admin");

// ===============================
// CONFIG
// ===============================
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// ===============================
// FIREBASE ADMIN INIT
// ===============================
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_JSON);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

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
// PUSH HELPERS
// ===============================
async function sendPushToUsers(userIds, title, body, data = {}) {
  if (!userIds.length) return;

  const [rows] = await db.query(
    `SELECT fcm_token FROM user_devices WHERE user_id IN (?)`,
    [userIds]
  );

  if (!rows.length) return;

  const tokens = rows.map(r => r.fcm_token);

  await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    ),
  });
}

async function sendPushToUser(userId, title, body, data = {}) {
  await sendPushToUsers([userId], title, body, data);
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
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ===============================
// REGISTER DEVICE (FCM)
// ===============================
app.post("/me/device", requireAuth, async (req, res, next) => {
  try {
    const { fcm_token, platform = "android" } = req.body;

    await db.query(
      `
      INSERT INTO user_devices (user_id, fcm_token, platform)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP
      `,
      [req.user.id, fcm_token, platform]
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// =======================================================
// STORE UPDATE STATUS → NOTIFY DRIVERS
// =======================================================
app.put("/store/orders/:id/status", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "STORE") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { status } = req.body;
    const storeId = await getStoreId(req.user.id);

    const [[delivery]] = await db.query(
      "SELECT * FROM deliveries WHERE id = ? AND store_id = ?",
      [req.params.id, storeId]
    );

    if (!delivery) return res.status(404).json({ message: "Not found" });

    // CREATED → PREPARING
    if (delivery.status === "CREATED" && status === "PREPARING") {
      await db.query(
        "UPDATE deliveries SET status='PREPARING' WHERE id=?",
        [delivery.id]
      );
    }

    // PREPARING → READY_FOR_PICKUP (🔥 notify drivers)
    if (delivery.status === "PREPARING" && status === "READY_FOR_PICKUP") {
      await db.query(
        "UPDATE deliveries SET status='READY_FOR_PICKUP' WHERE id=?",
        [delivery.id]
      );

      // get ALL drivers' user_ids
      const [drivers] = await db.query(
        `
        SELECT u.id AS user_id
        FROM drivers d
        JOIN users u ON u.id = d.user_id
        `
      );

      const driverUserIds = drivers.map(d => d.user_id);

      await sendPushToUsers(
        driverUserIds,
        "📦 New delivery available",
        "A store has a delivery ready for pickup",
        { deliveryId: delivery.id }
      );
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// =======================================================
// DRIVER STATUS UPDATE → NOTIFY STORE
// =======================================================
app.put("/driver/orders/:id/status", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "DRIVER") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { status } = req.body;
    const driverId = await getDriverId(req.user.id);

    const [[delivery]] = await db.query(
      "SELECT * FROM deliveries WHERE id = ?",
      [req.params.id]
    );

    if (!delivery) return res.status(404).json({ message: "Not found" });

    const [[store]] = await db.query(
      "SELECT user_id FROM stores WHERE id = ?",
      [delivery.store_id]
    );

    // ACCEPTED
    if (status === "ACCEPTED" && delivery.status === "READY_FOR_PICKUP") {
      await db.query(
        "UPDATE deliveries SET status='ACCEPTED', driver_id=? WHERE id=?",
        [driverId, delivery.id]
      );

      await sendPushToUser(
        store.user_id,
        "🚗 Driver accepted",
        "A driver accepted your delivery",
        { deliveryId: delivery.id }
      );
    }

    // PICKED_UP
    if (status === "PICKED_UP" && delivery.status === "ACCEPTED") {
      await db.query(
        "UPDATE deliveries SET status='PICKED_UP' WHERE id=?",
        [delivery.id]
      );

      await sendPushToUser(
        store.user_id,
        "📦 Order picked up",
        "Your order is on the way",
        { deliveryId: delivery.id }
      );
    }

    // DELIVERED
    if (status === "DELIVERED" && delivery.status === "PICKED_UP") {
      await db.query(
        "UPDATE deliveries SET status='DELIVERED' WHERE id=?",
        [delivery.id]
      );

      await sendPushToUser(
        store.user_id,
        "✅ Delivery completed",
        "The delivery was completed successfully",
        { deliveryId: delivery.id }
      );
    }

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
  res.status(500).json({ message: err.message });
});

// ===============================
// START SERVER
// ===============================
app.listen(PORT, () => {
  console.log(`✅ FlowerDrop API running on port ${PORT}`);
});
