const express = require("express");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const cors = require("cors");   // ✅ import cors
const proctoringRoutes = require("./Routes/proctoringRoutes.js");

const app = express();
app.use(bodyParser.json());
app.use(cors());  // ✅ enable CORS for all origins

// MongoDB connection
mongoose
  .connect("mongodb://127.0.0.1:27017/proctoringDB")
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error(err));

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
