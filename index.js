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
// FIREBASE ADMIN INIT (SAFE)
// ===============================
if (!admin.apps.length) {
  if (!process.env.FIREBASE_ADMIN_JSON) {
    console.error("❌ FIREBASE_ADMIN_JSON is NOT set");
  } else {
    try {
      const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_JSON);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log("✅ Firebase Admin initialized");
    } catch (e) {
      console.error("❌ Failed to parse FIREBASE_ADMIN_JSON", e);
    }
  }
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
    "SELECT fcm_token FROM user_devices WHERE user_id IN (?)",
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
    const { email, password } = req.body || {};
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
// REGISTER DEVICE (FCM)
// ===============================
app.post("/me/device", requireAuth, async (req, res, next) => {
  try {
    const { fcm_token, platform = "android" } = req.body;
    if (!fcm_token) return res.status(400).json({ message: "fcm_token required" });

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
// STORE
// =======================================================

// STORE ORDERS
app.get("/store/orders", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "STORE") return res.status(403).json({ message: "Forbidden" });

    const storeId = await getStoreId(req.user.id);
    const [deliveries] = await db.query(
      "SELECT * FROM deliveries WHERE store_id = ? ORDER BY created_at DESC",
      [storeId]
    );

    for (const d of deliveries) {
      const [proofs] = await db.query(
        "SELECT image_url FROM delivery_proofs WHERE delivery_id = ? ORDER BY created_at ASC",
        [d.id]
      );
      d.proof_images = proofs.map(p => p.image_url);

      const [inst] = await db.query(
        "SELECT buzz_code, unit, note FROM delivery_instructions WHERE delivery_id = ? LIMIT 1",
        [d.id]
      );
      d.delivery_instructions = inst[0] ?? null;

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
        d.driver = rows[0] ?? null;
      } else {
        d.driver = null;
      }
    }

    res.json(deliveries);
  } catch (err) {
    next(err);
  }
});

// STORE CREATE DELIVERY
app.post("/store/orders", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "STORE") return res.status(403).json({ message: "Forbidden" });

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
    } = req.body;

    const storeId = await getStoreId(req.user.id);

    const [result] = await db.query(
      `
      INSERT INTO deliveries
      (store_id, recipient_name, recipient_phone, tag_number,
       pickup_address, dropoff_address, deliver_after, deliver_before, status)
      VALUES (?, ?, ?, ?, 'STORE PICKUP', ?, ?, ?, 'CREATED')
      `,
      [
        storeId,
        recipient_name,
        recipient_phone,
        tag_number,
        dropoff_address,
        deliver_after,
        deliver_before,
      ]
    );

    if (buzz_code || unit || note) {
      await db.query(
        `
        INSERT INTO delivery_instructions (delivery_id, buzz_code, unit, note)
        VALUES (?, ?, ?, ?)
        `,
        [result.insertId, buzz_code, unit, note]
      );
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// STORE UPDATE STATUS + NOTIFY DRIVERS
app.put("/store/orders/:id/status", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "STORE") return res.status(403).json({ message: "Forbidden" });

    const { status } = req.body;
    const storeId = await getStoreId(req.user.id);

    const [[delivery]] = await db.query(
      "SELECT * FROM deliveries WHERE id = ? AND store_id = ?",
      [req.params.id, storeId]
    );

    if (!delivery) return res.status(404).json({ message: "Not found" });

    if (delivery.status === "CREATED" && status === "PREPARING") {
      await db.query("UPDATE deliveries SET status='PREPARING' WHERE id=?", [delivery.id]);
    }

    if (delivery.status === "PREPARING" && status === "READY_FOR_PICKUP") {
      await db.query("UPDATE deliveries SET status='READY_FOR_PICKUP' WHERE id=?", [delivery.id]);

      const [drivers] = await db.query(
        "SELECT u.id FROM drivers d JOIN users u ON u.id = d.user_id"
      );
      await sendPushToUsers(
        drivers.map(d => d.id),
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
// DRIVER
// =======================================================

// DRIVER ORDERS
app.get("/driver/orders", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "DRIVER") return res.status(403).json({ message: "Forbidden" });

    const driverId = await getDriverId(req.user.id);
    const [deliveries] = await db.query(
      `
      SELECT * FROM deliveries
      WHERE status IN ('READY_FOR_PICKUP','ACCEPTED','PICKED_UP')
        AND (driver_id IS NULL OR driver_id = ?)
      ORDER BY created_at DESC
      `,
      [driverId]
    );

    res.json(deliveries);
  } catch (err) {
    next(err);
  }
});

// DRIVER UPLOAD PROOF
app.post("/driver/orders/:id/proof", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "DRIVER") return res.status(403).json({ message: "Forbidden" });

    const { image_url } = req.body;
    const driverId = await getDriverId(req.user.id);

    const [[eligible]] = await db.query(
      "SELECT id FROM deliveries WHERE id=? AND driver_id=? AND status='PICKED_UP'",
      [req.params.id, driverId]
    );
    if (!eligible) return res.status(400).json({ message: "Not eligible" });

    const [[count]] = await db.query(
      "SELECT COUNT(*) AS c FROM delivery_proofs WHERE delivery_id=? AND uploaded_by='DRIVER'",
      [req.params.id]
    );
    if (count.c >= 2) return res.status(400).json({ message: "Max 2 proofs" });

    await db.query(
      `
      INSERT INTO delivery_proofs (delivery_id, image_url, uploaded_by, created_at)
      VALUES (?, ?, 'DRIVER', NOW())
      `,
      [req.params.id, image_url]
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DRIVER UPDATE STATUS + NOTIFY STORE
app.put("/driver/orders/:id/status", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "DRIVER") return res.status(403).json({ message: "Forbidden" });

    const { status } = req.body;
    const driverId = await getDriverId(req.user.id);

    const [[delivery]] = await db.query(
      "SELECT * FROM deliveries WHERE id=?",
      [req.params.id]
    );
    if (!delivery) return res.status(404).json({ message: "Not found" });

    const [[store]] = await db.query(
      "SELECT user_id FROM stores WHERE id=?",
      [delivery.store_id]
    );

    if (status === "ACCEPTED" && delivery.status === "READY_FOR_PICKUP") {
      await db.query(
        "UPDATE deliveries SET status='ACCEPTED', driver_id=? WHERE id=?",
        [driverId, delivery.id]
      );
      await sendPushToUser(store.user_id, "🚗 Driver accepted", "A driver accepted your delivery");
    }

    if (status === "PICKED_UP" && delivery.status === "ACCEPTED") {
      await db.query("UPDATE deliveries SET status='PICKED_UP' WHERE id=?", [delivery.id]);
      await sendPushToUser(store.user_id, "📦 Order picked up", "Your order is on the way");
    }

    if (status === "DELIVERED" && delivery.status === "PICKED_UP") {
      await db.query("UPDATE deliveries SET status='DELIVERED' WHERE id=?", [delivery.id]);
      await sendPushToUser(store.user_id, "✅ Delivery completed", "The delivery was completed");
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
  res.status(500).json({ message: err.message || "Internal server error" });
});

// ===============================
// START SERVER
// ===============================
app.listen(PORT, () => {
  console.log(`✅ FlowerDrop API running on port ${PORT}`);
});
