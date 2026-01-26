const express = require("express");
const mysql = require("mysql2/promise");

const app = express();
console.log("DbB HOST:", process.env.MYSQLHOST);
// Create MySQL pool using Railway env
const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: process.env.MYSQLPORT,
  waitForConnections: true,
  connectionLimit: 10,
});

app.get("/env-check", (req, res) => {
  res.json({
    host: process.env.MYSQLHOST,
    port: process.env.MYSQLPORT,
    user: process.env.MYSQLUSER,
    database: process.env.MYSQLDATABASE,
  });
});
app.get("/tables", async (req, res) => {
  try {
    const [rows] = await pool.query("SHOW TABLES");
    res.json({ success: true, tables: rows });
  } catch (err) {
    console.error("DB ERROR:", err); // 👈 IMPORTANT
    res.status(500).json({
      success: false,
      error: err,
    });
  }
});

// Root check
app.get("/", (req, res) => {
  res.send("API is running");
});

// DB test endpoint
app.get("/db-test", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT DATABASE() AS db");
    res.json({
      success: true,
      database: rows[0].db,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Railway port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Listening on port", PORT);
});
