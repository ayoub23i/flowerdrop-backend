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
// HELPERS (EXISTING)
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
// GEO HELPERS (FREE – NOMINATIM)
// ===============================
const NOMINATIM_UA =
  process.env.NOMINATIM_UA || "FlowerDrop/1.0 (contact: dev@flowerdrop.app)";

const lastGeoCall = new Map();

function rateLimitGeo(userId) {
  const now = Date.now();
  const last = lastGeoCall.get(userId) || 0;
  if (now - last < 1100) {
    throw new Error("Please wait before retrying");
  }
  lastGeoCall.set(userId, now);
}

async function geocodeAddressFree(address, userId) {
  if (!address) throw new Error("Address required");

  rateLimitGeo(userId);

  const url =
    "https://nominatim.openstreetmap.org/search" +
    `?q=${encodeURIComponent(address)}&format=json&limit=1`;

  const resp = await fetch(url, {
    headers: { "User-Agent": NOMINATIM_UA },
  });

  const data = await resp.json();
  if (!data.length) throw new Error("Address not found");

  return {
    lat: Number(data[0].lat),
    lng: Number(data[0].lon),
  };
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

function estimateEtaMinutes(km) {
  return Math.max(5, Math.round((km / 25) * 60));
}

async function getStorePickup(storeId) {
  const [[store]] = await db.query(
    "SELECT address, lat, lng FROM stores WHERE id = ?",
    [storeId]
  );
  if (!store || store.lat == null || store.lng == null) {
    throw new Error("Store pickup not set");
  }
  return {
    pickup_address: store.address,
    pickup_lat: Number(store.lat),
    pickup_lng: Number(store.lng),
  };
}

// ===============================
// HEALTH
// ===============================
app.get("/", (req, res) => {
  res.json({ message: "FlowerDrop API running" });
});

// ===============================
// STORE PREVIEW (NEW – FREE)
// ===============================
app.post("/store/orders/preview", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "STORE") return res.status(403).json({ message: "Forbidden" });

    const { dropoff_address } = req.body;
    const storeId = await getStoreId(req.user.id);

    const pickup = await getStorePickup(storeId);
    const drop = await geocodeAddressFree(dropoff_address, req.user.id);

    const distanceKm = haversineKm(
      pickup.pickup_lat,
      pickup.pickup_lng,
      drop.lat,
      drop.lng
    );

    res.json({
      distance_km: Number(distanceKm.toFixed(2)),
      eta_minutes: estimateEtaMinutes(distanceKm),
    });
  } catch (err) {
    next(err);
  }
});

// ===============================
// STORE CREATE DELIVERY (EXTENDED)
// ===============================
app.post("/store/orders", requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== "STORE") return res.status(403).json({ message: "Forbidden" });

    const {
      recipient_name,
      recipient_phone,
      dropoff_address,
      deliver_before,
      deliver_after,
      tag_number,
      note,
    } = req.body;

    const storeId = await getStoreId(req.user.id);
    const pickup = await getStorePickup(storeId);
    const drop = await geocodeAddressFree(dropoff_address, req.user.id);

    const distanceKm = haversineKm(
      pickup.pickup_lat,
      pickup.pickup_lng,
      drop.lat,
      drop.lng
    );

    await db.query(
      `
      INSERT INTO deliveries
      (store_id, recipient_name, recipient_phone, tag_number,
       pickup_address, pickup_lat, pickup_lng,
       dropoff_address, dropoff_lat, dropoff_lng,
       distance_km, eta_minutes,
       deliver_after, deliver_before, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED')
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
        estimateEtaMinutes(distanceKm),
        deliver_after,
        deliver_before,
      ]
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
  res.status(500).json({ message: err.message });
});

// ===============================
// START SERVER
// ===============================
app.listen(PORT, () => {
  console.log(`✅ FlowerDrop API running on port ${PORT}`);
});
