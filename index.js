const express = require("express");
const mysql = require("mysql2/promise");

const app = express();

// Create MySQL pool using Railway env
const pool = mysql.createPool(process.env.MYSQL_URL);

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
