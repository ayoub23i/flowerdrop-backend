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
// LOGIN
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

// ===============================
// STORE ORDERS (STORE → SEE DRIVER + PROOFS)
// ===============================
app.get("/store/orders", requireAuth, async (req, res) => {
  if (req.user.role !== "STORE") {
    return res.status(403).json({ message: "Forbidden" });
  }

  const storeId = await getStoreId(req.user.id);
  if (!storeId) {
    return res.status(400).json({ message: "Store not found" });
  }

  const [deliveries] = await db.query(
    "SELECT * FROM deliveries WHERE store_id = ? ORDER BY created_at DESC",
    [storeId]
  );

  for (const d of deliveries) {
    // Proof images
    const [proofs] = await db.query(
      "SELECT image_url FROM delivery_proofs WHERE delivery_id = ?",
      [d.id]
    );
    d.proof_images = proofs.map(p => p.image_url);

    // Driver info (drivers → users)
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
        ? {
            id: rows[0].id,
            name: rows[0].name,
            phone: rows[0].phone,
          }
        : null;
    } else {
      d.driver = null;
    }
  }

  res.json(deliveries);
});

// ===============================
// DRIVER ORDERS (DRIVER → SEE STORE)
// ===============================
app.get("/driver/orders", requireAuth, async (req, res) => {
  if (req.user.role !== "DRIVER") {
    return res.status(403).json({ message: "Forbidden" });
  }

  const driverId = await getDriverId(req.user.id);
  if (!driverId) {
    return res.status(400).json({ message: "Driver not found" });
  }

  const [deliveries] = await db.query(
    "SELECT * FROM deliveries WHERE driver_id = ? ORDER BY created_at DESC",
    [driverId]
  );

  for (const d of deliveries) {
    // Store info (stores → users)
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
      ? {
          id: rows[0].id,
          name: rows[0].name,
          phone: rows[0].phone,
        }
      : null;
  }

  res.json(deliveries);
});

// ===============================
// START SERVER
// ===============================
app.listen(PORT, () => {
  console.log(`✅ FlowerDrop API running on port ${PORT}`);
});
