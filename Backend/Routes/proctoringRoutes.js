const express = require("express");
const router = express.Router();
const ProctoringReport = require("../models/ProctoringReport");

// POST /api/proctoring/save-report
router.post("/save-report", async (req, res) => {
  try {
    const reportData = req.body;

    // Save to MongoDB
    const report = new ProctoringReport(reportData);
    await report.save();

    res.status(200).json({ message: "Report saved successfully" });
  } catch (err) {
    console.error("Failed to save report:", err);
    res.status(500).json({ error: "Failed to save report" });
  }
});

router.get("/reports", async (req, res) => {
  try {
    const reports = await ProctoringReport.find().sort({ createdAt: -1 });
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch reports" });
  }
});

module.exports = router;
