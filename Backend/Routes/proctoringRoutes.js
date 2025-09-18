const express = require("express");
const router = express.Router();
const ProctoringReport = require("../models/ProctoringReport");

// POST /api/proctoring/save-report
router.post("/save-report", async (req, res) => {
  try {
    const reportData = req.body;
    console.log(req.body);
    

    // Save to MongoDB
    const report = new ProctoringReport(reportData);
    await report.save();

    res.status(200).json({ message: "Report saved successfully" });
  } catch (err) {
    console.error("Failed to save report:", err);
    res.status(500).json({ error: "Failed to save report" });
  }
});

module.exports = router;
