const express = require("express");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const cors = require("cors"); // ✅ import cors
const proctoringRoutes = require("./Routes/proctoringRoutes.js");
require("dotenv").config(); // For loading environment variables

const app = express();
app.use(bodyParser.json());
app.use(cors()); // ✅ enable CORS for all origins

// MongoDB connection
const mongoURI = process.env.MONGO_URI;
if (!mongoURI) {
  console.error("Error: MONGO_URI not set in environment variables");
  process.exit(1);
}

mongoose
  .connect(mongoURI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  });

// API routes
app.use("/api/proctoring", proctoringRoutes);

// Test route
app.get("/", (req, res) => {
  console.log("Coming...");
  res.json({ msg: "Working fine" });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
