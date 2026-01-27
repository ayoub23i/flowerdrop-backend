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

// ===============================
// ME (optional, helpful)
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

// =======================================================
// STORE
// =======================================================

// ===============================
// STORE ORDERS (store sees proofs + driver)
// ===============================
app.get("/store/orders", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "STORE") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const storeId = await getStoreId(req.user.id);
    if (!storeId) return res.status(400).json({ message: "Store not found" });

    const [deliveries] = await db.query(
      "SELECT * FROM deliveries WHERE store_id = ? ORDER BY created_at DESC",
      [storeId]
    );

    for (const d of deliveries) {
      // proofs
      const [proofs] = await db.query(
        "SELECT image_url FROM delivery_proofs WHERE delivery_id = ? ORDER BY created_at ASC",
        [d.id]
      );
      d.proof_images = proofs.map((p) => p.image_url);

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

        d.driver = rows.length
          ? { id: rows[0].id, name: rows[0].name, phone: rows[0].phone }
          : null;
      } else {
        d.driver = null;
      }
    }

    res.json(deliveries);
  } catch (err) {
    next(err);
  }
});

// ===============================
// STORE CREATE DELIVERY (THIS IS WHAT BROKE)
// ===============================
app.post("/store/orders", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "STORE") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { recipient_name, recipient_phone, dropoff_address } = req.body || {};
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
// STORE UPDATE STATUS: CREATED->PREPARING->READY_FOR_PICKUP
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
    if (!current.length) return res.status(404).json({ message: "Delivery not found" });

    const cur = current[0].status;

    // enforce transition
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
// STORE DELETE DELIVERY (only early stages)
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
      return res.status(400).json({ message: "Cannot delete delivery at this stage" });
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// =======================================================
// DRIVER
// =======================================================

// ===============================
// DRIVER ORDERS (driver sees store; also sees available jobs)
// ===============================
app.get("/driver/orders", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "DRIVER") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const driverId = await getDriverId(req.user.id);
    if (!driverId) return res.status(400).json({ message: "Driver not found" });

    // show available + assigned-to-me in progress
    const [deliveries] = await db.query(
      `
      SELECT * FROM deliveries
      WHERE status IN ('READY_FOR_PICKUP','ACCEPTED','PICKED_UP')
        AND (driver_id IS NULL OR driver_id = ?)
      ORDER BY created_at DESC
      `,
      [driverId]
    );

    for (const d of deliveries) {
      // store info (stores -> users)
      const [rows] = await db.query(
        `
        SELECT s.id, u.name, u.phone
        FROM stores s
        JOIN users u ON u.id = s.user_id
        WHERE s.id = ?
        `,
        [d.store_id]
      );

      d.store = rows.length
        ? { id: rows[0].id, name: rows[0].name, phone: rows[0].phone }
        : null;
    }

    res.json(deliveries);
  } catch (err) {
    next(err);
  }
});

// ===============================
// DRIVER UPLOAD PROOF (max 2 total per delivery)
// ===============================
app.post("/driver/orders/:id/proof", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "DRIVER") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { image_url } = req.body || {};
    if (!image_url) return res.status(400).json({ message: "image_url is required" });

    const driverId = await getDriverId(req.user.id);
    if (!driverId) return res.status(400).json({ message: "Driver not found" });

    // must be assigned to this driver and picked up
    const [eligible] = await db.query(
      "SELECT id FROM deliveries WHERE id=? AND driver_id=? AND status='PICKED_UP'",
      [req.params.id, driverId]
    );
    if (!eligible.length) {
      return res.status(400).json({ message: "Delivery not eligible for proof upload" });
    }

    // count existing
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
      return res.status(400).json({ message: "Maximum of 2 proof photos allowed" });
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
// DRIVER UPDATE STATUS (enforce transitions + min 2 proofs for DELIVERED)
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

    // ACCEPTED: only if READY_FOR_PICKUP and unassigned
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

    // below: must be my delivery
    if (currentDriver !== driverId) {
      return res.status(403).json({ message: "Not your delivery" });
    }

    // PICKED_UP: only if ACCEPTED
    if (status === "PICKED_UP") {
      if (currentStatus !== "ACCEPTED") {
        return res.status(400).json({ message: "Must be ACCEPTED first" });
      }

      await db.query(
        "UPDATE deliveries SET status='PICKED_UP' WHERE id=? AND driver_id=?",
        [req.params.id, driverId]
      );
      return res.json({ success: true });
    }

    // DELIVERED: only if PICKED_UP and proofs>=2
    if (status === "DELIVERED") {
      if (currentStatus !== "PICKED_UP") {
        return res.status(400).json({ message: "Must be PICKED_UP first" });
      }

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
        return res.status(400).json({ message: "2 proof photos are required before delivery" });
      }

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
