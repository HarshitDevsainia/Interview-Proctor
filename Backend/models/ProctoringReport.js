const mongoose = require("mongoose");

const ProctoringReportSchema = new mongoose.Schema({
  candidateName: { type: String, required: true },
  startTime: { type: String },
  endTime: { type: String },
  durationMs: { type: Number },
  events: { type: Array, default: [] },
  summary: {
    counts: { type: Object, default: {} },
    deductions: { type: Number, default: 0 },
    finalScore: { type: Number, default: 100 },
  },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("ProctoringReport", ProctoringReportSchema);
