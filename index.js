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

// Mapbox geocoding (production)
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;

// Toronto bias (better local accuracy)
const TORONTO_BIAS_LNG = -79.3832;
const TORONTO_BIAS_LAT = 43.6532;

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
// PUSH HELPERS
// ===============================
async function sendPushToUsers(userIds, title, body, data = {}) {
  if (!admin.apps.length) return; // Firebase not initialized
  if (!userIds || !userIds.length) return;

  const [rows] = await db.query(
    "SELECT fcm_token FROM user_devices WHERE user_id IN (?)",
    [userIds]
  );
  if (!rows.length) return;

  const tokens = rows.map((r) => r.fcm_token).filter(Boolean);
  if (!tokens.length) return;

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
// GEO HELPERS (FREE) + HAVERSINE
// ===============================

// Soft rate limit for Nominatim (~1 request/sec per user)
const _geoLastCall = new Map();
function geoRateLimit(userId) {
  const now = Date.now();
  const last = _geoLastCall.get(userId) || 0;
  if (now - last < 1100) {
    const err = new Error("Please wait 1 second and retry");
    err.statusCode = 429;
    throw err;
  }
  _geoLastCall.set(userId, now);
}

function assertMapbox() {
  if (!MAPBOX_TOKEN) {
    const err = new Error("MAPBOX_TOKEN not set");
    err.statusCode = 500;
    throw err;
  }
}

async function geocodeAddress(address) {
  assertMapbox();

  if (!address || !address.trim()) {
    const err = new Error("dropoff_address required");
    err.statusCode = 400;
    throw err;
  }

  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/` +
    `${encodeURIComponent(address)}.json` +
    `?access_token=${MAPBOX_TOKEN}` +
    `&country=ca` +
    `&limit=1` +
    `&proximity=${TORONTO_BIAS_LNG},${TORONTO_BIAS_LAT}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    const err = new Error("Mapbox geocoding failed");
    err.statusCode = 502;
    throw err;
  }

  const data = await resp.json();
  if (!data.features || !data.features.length) {
    const err = new Error("Address not found");
    err.statusCode = 400;
    throw err;
  }

  const [lng, lat] = data.features[0].center;
  return { lat: Number(lat), lng: Number(lng) };
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (v) => (v * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function estimateEtaMinutes(distanceKm) {
  const avgSpeedKmh = 25; // simple Toronto avg
  return Math.max(5, Math.round((distanceKm / avgSpeedKmh) * 60));
}

async function getStorePickup(storeId) {
  const [[store]] = await db.query(
    "SELECT address, lat, lng FROM stores WHERE id = ?",
    [storeId]
  );

  if (!store) {
    const err = new Error("Store not found");
    err.statusCode = 400;
    throw err;
  }

  if (store.lat == null || store.lng == null) {
    const err = new Error("Store pickup lat/lng missing");
    err.statusCode = 400;
    throw err;
  }

  return {
    pickup_address: store.address || "Store pickup",
    pickup_lat: Number(store.lat),
    pickup_lng: Number(store.lng),
  };
}

// ===============================
// PRICING ENGINE (SINGLE SOURCE OF TRUTH) — FINAL FORMULA
// ===============================
const RUSH_FEE = 3.0;

function isRushHour(date) {
  const t = date.getHours() + date.getMinutes() / 60;
  return (t >= 7 && t <= 8.5) || (t >= 16 && t <= 18.5);
}

/**
 * FINAL FORMULA (base + profit cap + extra to driver)
 *
 * Step 1 — Base driver
 * if km <= 2: driver = 6
 * elif km <= 4: driver = 8
 * else: driver = 8 + (km − 4)
 *
 * Step 2 — Profit with cap
 * profit_raw = 4 + 0.12 × km
 * profit = min(profit_raw, 5)
 *
 * Step 3 — Give extra to driver
 * if profit_raw > 5: driver += (profit_raw − 5)
 *
 * Step 4 — Store price
 * store = driver + profit
 *
 * Rush fee (optional layer): if rush, store += 3
 */
function calculatePrice(distanceKm, deliverBefore, deliverAfter) {
  const km = Math.max(0, Number(distanceKm || 0));

  // --- pick effective datetime (same behavior as your current code) ---
  let effectiveDate = new Date();
  if (deliverBefore) effectiveDate = new Date(deliverBefore);
  if (deliverAfter) effectiveDate = new Date(deliverAfter);

  const rush = isRushHour(effectiveDate);

  // ---- Step 1: base driver ----
  let driver;
  if (km <= 2) driver = 6;
  else if (km <= 4) driver = 8;
  else driver = 8 + (km - 4);

  // ---- Step 2: profit with cap ----
  const profitRaw = 4 + 0.12 * km;
  const profit = Math.min(profitRaw, 5);

  // ---- Step 3: extra above cap goes to driver ----
  if (profitRaw > 5) {
    driver += (profitRaw - 5);
  }

  // ---- Step 4: store price ----
  let store = driver + profit;

  // ---- Rush layer (adds to store) ----
  const rushFee = rush ? RUSH_FEE : 0;
  store += rushFee;

  return {
    // new clear fields
    driver_price: Number(driver.toFixed(2)),
    platform_profit: Number(profit.toFixed(2)),
    profit_raw: Number(profitRaw.toFixed(2)),
    store_price: Number(store.toFixed(2)),

    // keep your existing fields (backward compatible for Flutter)
    base_price: Number(driver.toFixed(2)), // map driver payout here for now
    extra_distance_price: Number(0).toFixed ? 0 : 0, // kept for compatibility (not used anymore)
    rush_fee: Number(rushFee.toFixed(2)),
    rush_applied: rush,

    // keep old naming too
    total_price: Number(store.toFixed(2)),
  };
}

// Try to update price columns if they exist; ignore if schema not updated yet.
async function trySavePricing(deliveryId, pricing) {
  // 1) Always update the existing columns you already have
  try {
    await db.query(
      `
      UPDATE deliveries
      SET
        base_price = ?,
        extra_distance_price = ?,
        rush_fee = ?,
        total_price = ?
      WHERE id = ?
      `,
      [
        pricing.base_price,
        0, // extra_distance_price no longer used
        pricing.rush_fee,
        pricing.total_price,
        deliveryId,
      ]
    );
  } catch {
    // ignore
  }

  // 2) Update new columns if you added them
  try {
    await db.query(
      `
      UPDATE deliveries
      SET
        driver_price = ?,
        platform_profit = ?,
        profit_raw = ?,
        store_price = ?
      WHERE id = ?
      `,
      [
        pricing.driver_price,
        pricing.platform_profit,
        pricing.profit_raw,
        pricing.store_price,
        deliveryId,
      ]
    );
  } catch {
    // columns probably not added yet — safe ignore
  }
}


// Try to update price columns if they exist; ignore if schema not updated yet.
async function trySavePricing(deliveryId, pricing) {
  try {
    await db.query(
      `
      UPDATE deliveries
      SET
        base_price = ?,
        extra_distance_price = ?,
        rush_fee = ?,
        total_price = ?
      WHERE id = ?
      `,
      [
        pricing.base_price,
        pricing.extra_distance_price,
        pricing.rush_fee,
        pricing.total_price,
        deliveryId,
      ]
    );
  } catch {
    // columns probably don't exist yet — safe ignore
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
    const { fcm_token, platform = "android" } = req.body || {};
    if (!fcm_token) {
      return res.status(400).json({ message: "fcm_token is required" });
    }

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

// PREVIEW (distance + ETA + PRICE) before creating order
app.post("/store/orders/preview", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "STORE")
      return res.status(403).json({ message: "Forbidden" });

    const { dropoff_address, deliver_before = null, deliver_after = null } =
      req.body || {};

    if (!dropoff_address) {
      return res.status(400).json({ message: "dropoff_address required" });
    }

    const storeId = await getStoreId(req.user.id);
    if (!storeId) return res.status(400).json({ message: "Store not found" });

    const pickup = await getStorePickup(storeId);
    const drop = await geocodeAddress(dropoff_address, req.user.id);

    const distanceKm = haversineKm(
      pickup.pickup_lat,
      pickup.pickup_lng,
      drop.lat,
      drop.lng
    );

    const pricing = calculatePrice(distanceKm, deliver_before, deliver_after);

    res.json({
      distance_km: Number(distanceKm.toFixed(2)),
      eta_minutes: estimateEtaMinutes(distanceKm),
      ...pricing,

      pickup_address: pickup.pickup_address,
      pickup_lat: pickup.pickup_lat,
      pickup_lng: pickup.pickup_lng,
      dropoff_lat: drop.lat,
      dropoff_lng: drop.lng,
    });
  } catch (err) {
    next(err);
  }
});

// STORE ORDERS (LIST)
app.get("/store/orders", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "STORE")
      return res.status(403).json({ message: "Forbidden" });

    const storeId = await getStoreId(req.user.id);
    if (!storeId) return res.status(400).json({ message: "Store not found" });

    const [deliveries] = await db.query(
      "SELECT * FROM deliveries WHERE store_id = ? ORDER BY created_at DESC",
      [storeId]
    );

    for (const d of deliveries) {
      const [proofs] = await db.query(
        "SELECT image_url FROM delivery_proofs WHERE delivery_id = ? ORDER BY created_at ASC",
        [d.id]
      );
      d.proof_images = proofs.map((p) => p.image_url);

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

// STORE CREATE DELIVERY (FULL + GEO SAVE + PRICE SAVE)
app.post("/store/orders", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "STORE")
      return res.status(403).json({ message: "Forbidden" });

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
      return res.status(400).json({
        message: "recipient_name, recipient_phone, dropoff_address required",
      });
    }

    const storeId = await getStoreId(req.user.id);
    if (!storeId) return res.status(400).json({ message: "Store not found" });

    // pickup from stores table
    const pickup = await getStorePickup(storeId);

    // dropoff geocode (free)
    const drop = await geocodeAddress(dropoff_address, req.user.id);

    const distanceKm = haversineKm(
      pickup.pickup_lat,
      pickup.pickup_lng,
      drop.lat,
      drop.lng
    );
    const etaMinutes = estimateEtaMinutes(distanceKm);

    // Calculate pricing (same engine as preview)
    const pricing = calculatePrice(distanceKm, deliver_before, deliver_after);

    // INSERT delivery
    const [result] = await db.query(
      `
      INSERT INTO deliveries
      (
        store_id,
        recipient_name,
        recipient_phone,
        tag_number,
        pickup_address,
        pickup_lat,
        pickup_lng,
        dropoff_address,
        dropoff_lat,
        dropoff_lng,
        distance_km,
        eta_minutes,
        deliver_after,
        deliver_before,
        status
      )
      VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED')
      `,
      [
        storeId,
        recipient_name,
        recipient_phone,
        tag_number,
        pickup.pickup_address,
        pickup.pickup_lat,
        pickup.pickup_lng,
        dropoff_address,
        drop.lat,
        drop.lng,
        Number(distanceKm.toFixed(2)),
        etaMinutes,
        deliver_after,
        deliver_before,
      ]
    );

    // Save pricing if columns exist
    await trySavePricing(result.insertId, pricing);

    if (buzz_code || unit || note) {
      await db.query(
        `
        INSERT INTO delivery_instructions (delivery_id, buzz_code, unit, note)
        VALUES (?, ?, ?, ?)
        `,
        [result.insertId, buzz_code, unit, note]
      );
    }

    res.json({
      success: true,
      id: result.insertId,
      distance_km: Number(distanceKm.toFixed(2)),
      eta_minutes: etaMinutes,
      ...pricing,
    });
  } catch (err) {
    next(err);
  }
});

// STORE UPDATE STATUS + NOTIFY DRIVERS
app.put("/store/orders/:id/status", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "STORE")
      return res.status(403).json({ message: "Forbidden" });

    const { status } = req.body || {};
    const storeId = await getStoreId(req.user.id);

    const [[delivery]] = await db.query(
      "SELECT * FROM deliveries WHERE id = ? AND store_id = ?",
      [req.params.id, storeId]
    );

    if (!delivery) return res.status(404).json({ message: "Not found" });

    // CREATED → PREPARING
    if (delivery.status === "CREATED" && status === "PREPARING") {
      await db.query("UPDATE deliveries SET status='PREPARING' WHERE id=?", [
        delivery.id,
      ]);
    }

    // PREPARING → READY_FOR_PICKUP (notify drivers)
    if (delivery.status === "PREPARING" && status === "READY_FOR_PICKUP") {
      await db.query(
        "UPDATE deliveries SET status='READY_FOR_PICKUP' WHERE id=?",
        [delivery.id]
      );

      const [drivers] = await db.query(
        "SELECT u.id AS user_id FROM drivers d JOIN users u ON u.id = d.user_id"
      );
      const driverUserIds = drivers.map((d) => d.user_id);

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

// STORE DELETE DELIVERY (needed by Flutter)
app.delete("/store/orders/:id", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "STORE")
      return res.status(403).json({ message: "Forbidden" });

    const storeId = await getStoreId(req.user.id);
    const deliveryId = Number(req.params.id);

    const [[delivery]] = await db.query(
      "SELECT id, status FROM deliveries WHERE id=? AND store_id=?",
      [deliveryId, storeId]
    );
    if (!delivery) return res.status(404).json({ message: "Not found" });

    // simple safety: allow delete only before accepted
    if (["ACCEPTED", "PICKED_UP", "DELIVERED"].includes(delivery.status)) {
      return res
        .status(400)
        .json({ message: "Cannot delete after driver accepted" });
    }

    // delete children first if your DB does not cascade
    await db.query("DELETE FROM delivery_proofs WHERE delivery_id=?", [
      deliveryId,
    ]);
    await db.query("DELETE FROM delivery_instructions WHERE delivery_id=?", [
      deliveryId,
    ]);
    await db.query("DELETE FROM deliveries WHERE id=? AND store_id=?", [
      deliveryId,
      storeId,
    ]);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// =======================================================
// DRIVER
// =======================================================

// DRIVER ORDERS (LIST)
app.get("/driver/orders", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "DRIVER")
      return res.status(403).json({ message: "Forbidden" });

    const driverId = await getDriverId(req.user.id);
    if (!driverId) return res.status(400).json({ message: "Driver not found" });

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

// DRIVER UPLOAD PROOF (max 2)
app.post("/driver/orders/:id/proof", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "DRIVER")
      return res.status(403).json({ message: "Forbidden" });

    const { image_url } = req.body || {};
    if (!image_url) return res.status(400).json({ message: "image_url required" });

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
    if ((count?.c ?? 0) >= 2) {
      return res.status(400).json({ message: "Max 2 proofs" });
    }

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
    if (req.user.role !== "DRIVER")
      return res.status(403).json({ message: "Forbidden" });

    const { status } = req.body || {};
    const driverId = await getDriverId(req.user.id);

    const [[delivery]] = await db.query("SELECT * FROM deliveries WHERE id=?", [
      req.params.id,
    ]);
    if (!delivery) return res.status(404).json({ message: "Not found" });

    const [[store]] = await db.query("SELECT user_id FROM stores WHERE id=?", [
      delivery.store_id,
    ]);

    // ACCEPTED (only from READY_FOR_PICKUP)
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

    // PICKED_UP (only from ACCEPTED)
    if (status === "PICKED_UP" && delivery.status === "ACCEPTED") {
      await db.query("UPDATE deliveries SET status='PICKED_UP' WHERE id=?", [
        delivery.id,
      ]);
      await sendPushToUser(
        store.user_id,
        "📦 Order picked up",
        "Your order is on the way",
        { deliveryId: delivery.id }
      );
    }

    // DELIVERED (only from PICKED_UP)
    if (status === "DELIVERED" && delivery.status === "PICKED_UP") {
      await db.query("UPDATE deliveries SET status='DELIVERED' WHERE id=?", [
        delivery.id,
      ]);
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
// ADDRESS AUTOCOMPLETE (MAPBOX)
// ===============================
app.get("/geo/autocomplete", requireAuth, async (req, res, next) => {
  try {
    assertMapbox();

    const { q } = req.query;
    if (!q || q.length < 3) return res.json([]);

    const url =
      `https://api.mapbox.com/geocoding/v5/mapbox.places/` +
      `${encodeURIComponent(q)}.json` +
      `?access_token=${MAPBOX_TOKEN}` +
      `&country=ca` +
      `&types=address,place,postcode` +
      `&autocomplete=true` +
      `&limit=6` +
      `&proximity=${TORONTO_BIAS_LNG},${TORONTO_BIAS_LAT}`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error("Autocomplete failed");

    const data = await resp.json();

    const results = (data.features || []).map((f) => ({
      label: f.place_name,
      lat: Number(f.center?.[1]),
      lng: Number(f.center?.[0]),
    }));

    res.json(results);
  } catch (err) {
    next(err);
  }
});

// ===============================
// ADDRESS RESOLUTION (MAPBOX)
// ===============================
app.post("/geo/resolve", requireAuth, async (req, res, next) => {
  try {
    assertMapbox();

    const { query } = req.body || {};
    if (!query || query.length < 3) return res.json([]);

    const url =
      `https://api.mapbox.com/geocoding/v5/mapbox.places/` +
      `${encodeURIComponent(query)}.json` +
      `?access_token=${MAPBOX_TOKEN}` +
      `&country=ca` +
      `&types=address,place,postcode` +
      `&autocomplete=true` +
      `&limit=8` +
      `&proximity=${TORONTO_BIAS_LNG},${TORONTO_BIAS_LAT}`;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error("Resolve failed");

    const data = await resp.json();

    const results = (data.features || []).map((f) => ({
      label: f.place_name,
      lat: Number(f.center?.[1]),
      lng: Number(f.center?.[0]),
    }));

    res.json(results);
  } catch (err) {
    next(err);
  }
});


// ===============================
// GLOBAL ERROR HANDLER
// ===============================
app.use((err, req, res, next) => {
  console.error("❌ API ERROR:", err);
  res.status(err.statusCode || 500).json({
    message: err.message || "Internal server error",
  });
});

// ===============================
// START SERVER
// ===============================
app.listen(PORT, () => {
  console.log(`✅ FlowerDrop API running on port ${PORT}`);
});
