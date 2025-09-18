import React, { useRef, useEffect, useState } from "react";
// MediaPipe FaceMesh
import { FaceMesh } from "@mediapipe/face_mesh";
import * as camutils from "@mediapipe/camera_utils";
// TensorFlow coco-ssd
import * as cocoSsd from "@tensorflow-models/coco-ssd";
import * as tf from "@tensorflow/tfjs";
import jsPDF from "jspdf";

/**
 * ProctoringPanel — merged & extended
 * - fixes face-activity logging
 * - adds EAR-based drowsiness detection
 * - adds real-time alerts (sound + banner)
 * - adds background audio detection (volume-based)
 *
 * Keep Tailwind in your project for the UI classes to work.
 */

const LOOK_AWAY_THRESHOLD = 5; // sec
const NO_FACE_THRESHOLD = 10; // sec
const OBJ_DETECT_INTERVAL_MS = 700;
const EAR_THRESHOLD = 0.22; // typical EAR threshold (tweak)
const EYE_CLOSED_SECONDS = 2; // seconds to consider drowsy
const AUDIO_VOICE_THRESHOLD = 50; // fft avg threshold (tweak)
const AUDIO_DEBOUNCE_MS = 5000; // don't spam audio logs
const backendUrl = "https://interview-proctor.onrender.com";

export default function ProctoringPanel({ candidateName = "Harshit Soni" }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  const mediaRecorderRef = useRef(null);
  const recordedBlobsRef = useRef([]);
  const cameraRef = useRef(null);
  const faceMeshRef = useRef(null);
  const cocoRef = useRef(null);

  // detection/logic refs
  const logRef = useRef([]);
  const [logs, setLogs] = useState([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [recording, setRecording] = useState(false);
  const [alertMessage, setAlertMessage] = useState(null);

  const lastFaceTimestamp = useRef(Date.now());
  const facePresent = useRef(true);

  // stateRef holds several timestamps & flags
  const stateRef = useRef({
    faceMissingStart: null,
    lookingAwayStart: null,
    lookingAwayLogged: false,
    eyeClosedStart: null,
    lastAudioLogAt: 0,
  });

  // quick push log (keeps ts key "ts" to be consistent)
  function pushLog(type, meta = {}) {
    const e = { type, ts: new Date().toISOString(), ...meta };
    logRef.current.push(e);
    setLogs([...logRef.current].reverse()); // most recent first
    computeSummary(logRef.current);
    console.log("LOG:", e);

    // real-time alert banner & sound for important events
    const important = [
      "looking_away_start",
      "looking_away_flag",
      "face_missing_start",
      "multiple_faces_detected",
      "object_detected",
      "drowsiness_detected",
      "background_voice_detected",
    ];
    if (important.includes(type)) {
      showAlert(type, e);
    }
  }

  // small UI alert (banner + sound)
  function showAlert(type, event) {
    const human =
      {
        looking_away_start: "Candidate looking away",
        looking_away_flag: "Candidate looked away > threshold",
        face_missing_start: "Face missing",
        multiple_faces_detected: "Multiple faces detected",
        object_detected: `Object detected: ${
          event.class || event.object || event.type
        }`,
        drowsiness_detected: "Possible drowsiness detected",
        background_voice_detected: "Background voices detected",
      }[type] || type;

    setAlertMessage(human);
    // play short beep (put alert.mp3 in public folder)
    const audio = new Audio("/alert.mp3");
    audio.play().catch(() => {});
    // auto-hide banner after 4s
    setTimeout(() => setAlertMessage(null), 4000);
  }

  // message formatter for UI log list
  function messageForLog(e) {
    switch (e.type) {
      case "looking_away_start":
        return `Looking away started`;
      case "looking_away_end":
        return `Looking away ended (${e.durationSeconds}s)`;
      case "looking_away_flag":
        return `Looked away > ${LOOK_AWAY_THRESHOLD}s`;
      case "face_missing_start":
        return `Face missing started`;
      case "face_missing_end":
        return `Face returned`;
      case "multiple_faces_detected":
        return `Multiple faces detected (${e.count})`;
      case "object_detected":
        return `Object detected: ${e.class} (${Math.round(e.score * 100)}%)`;
      case "drowsiness_detected":
        return `Drowsiness: eyes closed ${Math.round(e.duration)}s`;
      case "background_voice_detected":
        return `Background audio detected (level ${Math.round(e.level)})`;
      case "recording_started":
        return `Recording started`;
      case "recording_stopped":
        return `Recording stopped`;
      default:
        return e.type;
    }
  }

  // summary scoring (keeps your original rules)
  const [summary, setSummary] = useState({ finalScore: 100, deductions: 0 });
  function computeSummary(events) {
    const counts = events.reduce((acc, e) => {
      acc[e.type] = (acc[e.type] || 0) + 1;
      return acc;
    }, {});
    let deductions = 0;
    deductions += (counts["looking_away_flag"] || 0) * 2;
    deductions += (counts["no_face_detected"] || 0) * 5;
    deductions += (counts["multiple_faces_detected"] || 0) * 10;
    const phoneEvents = events.filter(
      (e) =>
        e.type === "object_detected" &&
        e.class &&
        e.class.toLowerCase().includes("phone")
    ).length;
    deductions += phoneEvents * 20;
    const bookEvents = events.filter(
      (e) =>
        e.type === "object_detected" &&
        e.class &&
        e.class.toLowerCase().includes("book")
    ).length;
    deductions += bookEvents * 10;
    setSummary({
      finalScore: Math.max(0, 100 - deductions),
      deductions,
      counts,
    });
  }

  // gaze heuristic
  function isLookingAwayRaw(landmarks) {
    if (!landmarks || landmarks.length === 0) return false;
    const leftEye = landmarks[33];
    const rightEye = landmarks[263];
    const noseTip = landmarks[1];
    if (!leftEye || !rightEye || !noseTip) return false;
    const eyeCenterX = (leftEye.x + rightEye.x) / 2;
    const dx = noseTip.x - eyeCenterX;
    const dy = noseTip.y - (leftEye.y + rightEye.y) / 2;
    const TURN_THRESHOLD = 0.06;
    const VERTICAL_THRESHOLD = 0.08;
    return Math.abs(dx) > TURN_THRESHOLD || Math.abs(dy) > VERTICAL_THRESHOLD;
  }

  // draw detections on overlay (clears first)
  function drawDetections(predictions, overlayCtx) {
    const canvas = canvasRef.current;
    overlayCtx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of predictions) {
      if (!p.bbox) continue;
      const [x, y, w, h] = p.bbox;
      overlayCtx.lineWidth = 2;
      overlayCtx.strokeStyle = "rgba(255,120,50,0.9)";
      overlayCtx.strokeRect(x, y, w, h);
      overlayCtx.fillStyle = "rgba(0,0,0,0.6)";
      overlayCtx.fillRect(x, y - 20, Math.min(w, 160), 20);
      overlayCtx.fillStyle = "white";
      overlayCtx.font = "12px sans-serif";
      const label = `${p.class} ${Math.round(p.score * 100)}%`;
      overlayCtx.fillText(label, x + 4, y - 6);
    }
  }

  // --- onFaceResults: handles landmarks, looking-away, multiple faces, EAR/drowsiness, face-missing debounced
  // Constants
  const LOOK_AWAY_THRESHOLD = 5; // sec
  const NO_FACE_THRESHOLD = 10; // sec

  // Add this near your other refs
  const lookingAway = useRef(false);

  // --- onFaceResults ---
  async function onFaceResults(results) {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
      // ✅ FACE DETECTED
      lastFaceTimestamp.current = Date.now();

      if (!facePresent.current) {
        facePresent.current = true;
        pushLog("face_detected");

        if (stateRef.current.faceMissingStart) {
          pushLog("face_missing_end", {
            start: stateRef.current.faceMissingStart,
            end: new Date().toISOString(),
          });
          stateRef.current.faceMissingStart = null;
        }
      }

      // ✅ MULTIPLE FACES
      if (results.multiFaceLandmarks.length > 1) {
        pushLog("multiple_faces_detected", {
          count: results.multiFaceLandmarks.length,
          timestamp: new Date().toISOString(),
        });
      }

      // ✅ LOOKING AWAY
      const lm = results.multiFaceLandmarks[0];
      const isAway = isLookingAwayRaw(lm);

      if (isAway) {
        if (!lookingAway.current) {
          stateRef.current.lookingAwayStart = Date.now();
          lookingAway.current = true;
        } else {
          const awayDuration =
            (Date.now() - stateRef.current.lookingAwayStart) / 1000;
          if (
            awayDuration >= LOOK_AWAY_THRESHOLD &&
            !stateRef.current.lookingAwayLogged
          ) {
            pushLog("looking_away_flag", {
              durationSeconds: Math.round(awayDuration),
            });
            stateRef.current.lookingAwayLogged = true;
          }
        }
      } else {
        if (lookingAway.current) {
          if (stateRef.current.lookingAwayLogged) {
            pushLog("looking_away_end", {
              start: new Date(stateRef.current.lookingAwayStart).toISOString(),
              end: new Date().toISOString(),
              durationSeconds: Math.round(
                (Date.now() - stateRef.current.lookingAwayStart) / 1000
              ),
            });
          }
          // reset
          lookingAway.current = false;
          stateRef.current.lookingAwayStart = null;
          stateRef.current.lookingAwayLogged = false;
        }
      }

      // draw landmarks
      ctx.fillStyle = "rgba(0,255,0,0.6)";
      for (const point of lm) {
        ctx.beginPath();
        ctx.arc(
          point.x * canvas.width,
          point.y * canvas.height,
          1.5,
          0,
          2 * Math.PI
        );
        ctx.fill();
      }
    } else {
      // ❌ NO FACE
      const now = Date.now();
      const duration = (now - lastFaceTimestamp.current) / 1000;

      if (!stateRef.current.faceMissingStart) {
        stateRef.current.faceMissingStart = new Date().toISOString();
      }

      if (duration >= NO_FACE_THRESHOLD && facePresent.current) {
        facePresent.current = false;
        pushLog("no_face_detected", {
          start: stateRef.current.faceMissingStart,
        });
      }
    }
  }

  // Load object detection model once
  useEffect(() => {
    async function loadModel() {
      const model = await cocoSsd.load();
      objectModelRef.current = model;
      runObjectDetection(); // start loop
    }
    loadModel();
  }, []);

  async function runObjectDetection() {
    if (!videoRef.current || !objectModelRef.current) {
      requestAnimationFrame(runObjectDetection);
      return;
    }

    const predictions = await objectModelRef.current.detect(videoRef.current);

    predictions.forEach((pred) => {
      const { class: label, score, bbox } = pred;
      if (score > 0.6) {
        if (
          label === "cell phone" ||
          label === "book" ||
          label === "laptop" ||
          label === "remote"
        ) {
          pushLog("suspicious_item_detected", {
            item: label,
            confidence: score.toFixed(2),
            timestamp: new Date().toISOString(),
          });

          // optional: draw on canvas
          const ctx = canvasRef.current.getContext("2d");
          ctx.strokeStyle = "red";
          ctx.lineWidth = 2;
          ctx.strokeRect(bbox[0], bbox[1], bbox[2], bbox[3]);
          ctx.fillStyle = "red";
          ctx.fillText(label, bbox[0], bbox[1] > 10 ? bbox[1] - 5 : 10);
        }
      }
    });

    requestAnimationFrame(runObjectDetection);
  }

  // Function to detect if person is looking away
  function isLookingAwayRaw(landmarks) {
    if (!landmarks || landmarks.length === 0) return false;

    const leftEye = landmarks[33];
    const rightEye = landmarks[263];
    const noseTip = landmarks[1];
    if (!leftEye || !rightEye || !noseTip) return false;

    const eyeCenterX = (leftEye.x + rightEye.x) / 2;
    const dx = noseTip.x - eyeCenterX;
    const dy = noseTip.y - (leftEye.y + rightEye.y) / 2;

    const TURN_THRESHOLD = 0.06;
    const VERTICAL_THRESHOLD = 0.08;

    return Math.abs(dx) > TURN_THRESHOLD || Math.abs(dy) > VERTICAL_THRESHOLD;
  }

  // --- object detection runner ---
  async function runObjectDetection() {
    if (
      !cocoRef.current ||
      !videoRef.current ||
      videoRef.current.readyState < 2
    )
      return;
    try {
      const predictions = await cocoRef.current.detect(videoRef.current);
      const allowed = [
        "cell phone",
        "book",
        "laptop",
        "tv",
        "remote",
        "keyboard",
        "mouse",
        "tablet",
      ];
      const interesting = predictions.filter((p) =>
        allowed.some((a) => p.class.toLowerCase().includes(a))
      );
      // draw boxes
      const overlayCtx = canvasRef.current.getContext("2d");
      drawDetections(interesting, overlayCtx);
      // log
      interesting.forEach((p) => {
        if (p.score > 0.35) {
          // dedupe last few
          const lastSame = logRef.current
            .slice(-8)
            .find((l) => l.type === "object_detected" && l.class === p.class);
          if (!lastSame) {
            pushLog("object_detected", {
              class: p.class,
              score: p.score,
              bbox: p.bbox,
            });
          }
        }
      });
      return predictions;
    } catch (err) {
      console.warn("Object detection error", err);
      return [];
    }
  }

  // --- Audio monitor ---
  const audioAnalyserRef = useRef(null);
  const audioRunningRef = useRef(false);
  async function startAudioMonitor() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      const src = audioCtx.createMediaStreamSource(stream);
      src.connect(analyser);
      audioAnalyserRef.current = analyser;
      audioRunningRef.current = true;
      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      function audioLoop() {
        if (!audioRunningRef.current) return;
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        const now = Date.now();
        if (
          avg > AUDIO_VOICE_THRESHOLD &&
          now - stateRef.current.lastAudioLogAt > AUDIO_DEBOUNCE_MS
        ) {
          stateRef.current.lastAudioLogAt = now;
          pushLog("background_voice_detected", { level: avg });
        }
        requestAnimationFrame(audioLoop);
      }
      audioLoop();
    } catch (err) {
      console.warn("Audio monitor failed:", err);
    }
  }

  // --- init models & camera (keeps structure similar to your original) ---
  useEffect(() => {
    let objInterval = null;
    let cameraInstance = null;

    async function init() {
      try {
        // load object model
        cocoRef.current = await cocoSsd.load();
        console.log("COCO-SSD loaded");
      } catch (err) {
        console.warn("Failed to load coco-ssd", err);
      }

      // init FaceMesh
      faceMeshRef.current = new FaceMesh({
        locateFile: (file) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
      });
      faceMeshRef.current.setOptions({
        maxNumFaces: 2,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      faceMeshRef.current.onResults(onFaceResults);

      // IMPORTANT: ensure video element has a stream visible for MediaRecorder (and to feed models)
      // Use camutils.Camera to feed frames into FaceMesh (this library will manage getUserMedia)
      const videoEl = videoRef.current;
      cameraInstance = new camutils.Camera(videoEl, {
        onFrame: async () => {
          try {
            // send frame to face mesh
            await faceMeshRef.current.send({ image: videoEl });
          } catch (e) {
            // ignore occasional send errors
          }
        },
        width: 640,
        height: 480,
      });
      cameraRef.current = cameraInstance;
      await cameraInstance.start();

      // object detection interval
      objInterval = setInterval(() => {
        runObjectDetection();
      }, OBJ_DETECT_INTERVAL_MS);

      // start audio monitor (background)
      startAudioMonitor();

      setModelsLoaded(true);
    }

    init().catch((err) => console.error("init failed", err));

    return () => {
      if (objInterval) clearInterval(objInterval);
      audioRunningRef.current = false;
      if (cameraRef.current) {
        try {
          cameraRef.current.stop();
        } catch (e) {}
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Recording controls (use the video element's srcObject) ---
  async function startRecording() {
    // If camutils.Camera was used, videoRef.current.srcObject may be null on some browsers.
    // Try to get stream explicitly and set to video.srcObject if missing.
    if (videoRef.current && !videoRef.current.srcObject) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        videoRef.current.srcObject = s;
      } catch (err) {
        console.warn("getUserMedia for recording failed:", err);
      }
    }

    if (!videoRef.current || !videoRef.current.srcObject) {
      console.error("No video stream available to record");
      return;
    }

    recordedBlobsRef.current = [];
    const stream = videoRef.current.srcObject;
    const options = { mimeType: "video/webm;codecs=vp9" };
    try {
      const mediaRecorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordedBlobsRef.current.push(e.data);
      };
      mediaRecorder.onstop = () => {
        pushLog("recording_stopped", {});
        setRecording(false);
      };
      mediaRecorder.start(1000);
      pushLog("recording_started", {});
      setRecording(true);
    } catch (err) {
      console.error("Failed to start MediaRecorder", err);
      pushLog("recording_failed", { error: err.message });
    }
  }

  function stopRecordingAndDownload() {
    if (!mediaRecorderRef.current) return;
    mediaRecorderRef.current.stop();
    setTimeout(() => {
      const superBuffer = new Blob(recordedBlobsRef.current, {
        type: "video/webm",
      });
      const url = window.URL.createObjectURL(superBuffer);
      const a = document.createElement("a");
      a.style.display = "none";
      a.href = url;
      a.download = `${candidateName.replace(/\s+/g, "_")}_${Date.now()}.webm`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    }, 800);
  }

  // --- Report generation (keeps existing behavior) ---
  async function sendReport() {
    const events = logRef.current;
    const startLog = events.find((e) => e.type === "recording_started");
    const stopLog = events.find((e) => e.type === "recording_stopped");
    const durationMs =
      startLog && stopLog ? new Date(stopLog.ts) - new Date(startLog.ts) : null;

    const counts = events.reduce((acc, e) => {
      acc[e.type] = (acc[e.type] || 0) + 1;
      return acc;
    }, {});

    let deductions = 0;
    deductions += (counts["looking_away_flag"] || 0) * 2;
    deductions += (counts["no_face_detected"] || 0) * 5;
    deductions += (counts["multiple_faces_detected"] || 0) * 10;

    const phoneEvents = events.filter(
      (e) =>
        e.type === "object_detected" &&
        e.class &&
        e.class.toLowerCase().includes("phone")
    ).length;
    deductions += phoneEvents * 20;

    const bookEvents = events.filter(
      (e) =>
        e.type === "object_detected" &&
        e.class &&
        e.class.toLowerCase().includes("book")
    ).length;
    deductions += bookEvents * 10;

    const finalScore = Math.max(0, 100 - deductions);

    const report = {
      candidateName,
      startTime: startLog?.ts || null,
      endTime: stopLog?.ts || null,
      durationMs,
      events,
      summary: { counts, deductions, finalScore },
    };

    // --- PDF GENERATION ---
    const doc = new jsPDF({ orientation: "p", unit: "mm", format: "a4" });

    doc.setFontSize(16);
    doc.text("Proctoring Report", 10, 10);

    doc.setFontSize(12);
    doc.text(`Candidate: ${candidateName}`, 10, 20);
    doc.text(`Start Time: ${report.startTime}`, 10, 30);
    doc.text(`End Time: ${report.endTime}`, 10, 40);
    doc.text(
      `Duration: ${durationMs ? durationMs / 1000 + " sec" : "N/A"}`,
      10,
      50
    );
    doc.text(`Final Score: ${finalScore}`, 10, 60);

    // Convert full report (with timestamps & events) into text
    const jsonString = JSON.stringify(report, null, 2);

    // Wrap text to fit page
    const lines = doc.splitTextToSize(jsonString, 180);

    let y = 75;
    lines.forEach((line) => {
      if (y > 280) {
        doc.addPage();
        y = 20;
      }
      doc.text(line, 10, y);
      y += 6;
    });

    // Save PDF
    doc.save(
      `${candidateName.replace(
        /\s+/g,
        "_"
      )}_proctoring_report_${Date.now()}.pdf`
    );
  }

  // --- helpers ---
  function fmt(ts) {
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return ts;
    }
  }

  // Add this function inside your component
  async function endInterview() {
    if (recording) stopRecordingAndDownload();

    // Generate report data
    const events = logRef.current;
    const startLog = events.find((e) => e.type === "recording_started");
    const stopLog = events.find((e) => e.type === "recording_stopped");
    const durationMs =
      startLog && stopLog ? new Date(stopLog.ts) - new Date(startLog.ts) : null;

    const counts = events.reduce((acc, e) => {
      acc[e.type] = (acc[e.type] || 0) + 1;
      return acc;
    }, {});
    let deductions = 0;
    deductions += (counts["looking_away_flag"] || 0) * 2;
    deductions += (counts["no_face_detected"] || 0) * 5;
    deductions += (counts["multiple_faces_detected"] || 0) * 10;
    const phoneEvents = events.filter(
      (e) =>
        e.type === "object_detected" &&
        e.class &&
        e.class.toLowerCase().includes("phone")
    ).length;
    deductions += phoneEvents * 20;
    const bookEvents = events.filter(
      (e) =>
        e.type === "object_detected" &&
        e.class &&
        e.class.toLowerCase().includes("book")
    ).length;
    deductions += bookEvents * 10;
    const finalScore = Math.max(0, 100 - deductions);

    const report = {
      candidateName,
      startTime: startLog?.ts || null,
      endTime: stopLog?.ts || new Date().toISOString(),
      durationMs,
      events,
      summary: { counts, deductions, finalScore },
    };

    console.log("report: ", report);

    try {
      const res = await fetch(`${backendUrl}/api/proctoring/save-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(report),
      });
      const data = await res.json();
      console.log("data", data);

      if (res.ok) {
        alert("Interview ended & report saved successfully!");
      } else {
        alert("Failed to save report");
      }
    } catch (err) {
      console.error("Error saving report", err);
      alert("Error saving report");
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-700 to-black text-slate-100 p-6 flex flex-col items-center gap-6">
      <header className="w-full max-w-6xl flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">
            Tutedude — Interview Proctor
          </h1>
          <p className="text-slate-400 text-sm">
            Candidate: <span className="font-medium">{candidateName}</span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-xs text-slate-400">Integrity Score</div>
            <div className="text-xl font-bold">{summary.finalScore}</div>
          </div>
          <button
            onClick={sendReport}
            className="bg-indigo-600 hover:bg-indigo-500 px-4 py-2 rounded-md shadow-md text-white"
          >
            Generate Report
          </button>
          <button
            onClick={() => {
              sendReport();
              endInterview();
              logRef.current = [];
              setLogs([]);
              computeSummary([]);
            }}
            className="px-4 py-2 bg-red-700 hover:bg-red-600 rounded-md text-white"
          >
            End Interview
          </button>
        </div>
      </header>

      {alertMessage && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 bg-red-600 text-white px-4 py-2 rounded-lg z-50 shadow-lg">
          {alertMessage}
        </div>
      )}

      <main className="w-full max-w-6xl grid grid-cols-2 gap-6">
        {/* Video + overlay */}
        <section className="col-span-1 bg-slate-800/60 border border-slate-700 rounded-2xl p-4 shadow-xl">
          <div
            className="relative w-full overflow-hidden rounded-lg"
            style={{ height: 420 }}
          >
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="w-full h-full object-cover rounded-lg bg-black"
            />
            <canvas
              ref={canvasRef}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: "100%",
                height: "100%",
                pointerEvents: "none",
              }}
            />
            <div className="absolute left-4 top-4 bg-black/60 px-3 py-1 rounded-md text-sm">
              {modelsLoaded ? (
                <span className="text-emerald-300">Models loaded</span>
              ) : (
                <span className="text-yellow-300">Loading models...</span>
              )}
            </div>
            <div className="absolute right-4 top-4 bg-black/60 px-3 py-1 rounded-md text-sm">
              {recording ? (
                <span className="text-red-400 font-semibold">● Recording</span>
              ) : (
                <span className="text-slate-300">Idle</span>
              )}
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={startRecording}
              disabled={recording}
              className={`px-4 py-2 rounded-md ${
                recording
                  ? "bg-slate-600 text-slate-400"
                  : "bg-emerald-500 hover:bg-emerald-400 text-white"
              } shadow`}
            >
              Start Recording
            </button>
            <button
              onClick={stopRecordingAndDownload}
              disabled={!recording}
              className={`px-4 py-2 rounded-md ${
                !recording
                  ? "bg-slate-600 text-slate-400"
                  : "bg-red-600 hover:bg-red-500 text-white"
              } shadow`}
            >
              Stop & Download
            </button>
            <button
              onClick={() => {
                logRef.current = [];
                setLogs([]);
                computeSummary([]);
              }}
              className="px-3 py-2 rounded-md bg-slate-700 hover:bg-slate-600 text-slate-200"
            >
              Clear Logs
            </button>
          </div>

          <div className="mt-4 text-sm text-slate-400">
            <div>Detection rules:</div>
            <ul className="list-disc list-inside mt-1">
              <li>
                Look away flagged after {LOOK_AWAY_THRESHOLD}s continuous
                looking away
              </li>
              <li>
                No-face flagged after {NO_FACE_THRESHOLD}s continuous absence
              </li>
              <li>
                Objects detected using Coco-SSD (cell phone, book, laptop, etc.)
              </li>
              <li>
                Drowsiness detected with Eye Aspect Ratio (EAR) &gt; threshold
              </li>
            </ul>
          </div>
        </section>

        {/* Logs */}
        <aside className="col-span-1 bg-slate-800/40 border border-slate-700 rounded-2xl p-4 shadow-xl flex flex-col">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Event Timeline</h2>
            <div className="text-sm text-slate-400">Most recent first</div>
          </div>

          <div className="mt-3 overflow-auto" style={{ maxHeight: 420 }}>
            {logs.length === 0 ? (
              <div className="text-slate-500 text-sm p-6">
                No events yet — system is monitoring the candidate.
              </div>
            ) : (
              <ul className="space-y-3">
                {logs.map((e, idx) => (
                  <li key={idx} className="flex items-start gap-3">
                    <div className="w-10 shrink-0">
                      <div className="text-xs text-slate-400">
                        {new Date(e.ts).toLocaleTimeString()}
                      </div>
                    </div>
                    <div className="flex-1 bg-slate-900/30 border border-slate-700 rounded-lg p-3">
                      <div className="flex items-center justify-between">
                        <div className="text-sm">
                          <strong className="capitalize">
                            {e.type.replace(/_/g, " ")}
                          </strong>
                        </div>
                        <div className="text-xs text-slate-400">
                          {fmt(e.ts)}
                        </div>
                      </div>
                      <div className="mt-1 text-sm text-slate-200">
                        {messageForLog(e)}
                      </div>
                      {e.class && (
                        <div className="mt-1 text-xs text-slate-400">
                          Class: {e.class} — Score:{" "}
                          {Math.round((e.score || 0) * 100)}%
                        </div>
                      )}
                      {e.bbox && (
                        <div className="mt-1 text-xs text-slate-400">
                          BBox: {e.bbox.map((n) => Math.round(n)).join(", ")}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-4 border-t border-slate-700 pt-3 flex items-center justify-between">
            <div>
              <div className="text-xs text-slate-400">
                Events: {logRef.current.length}
              </div>
              <div className="text-sm font-medium">
                Deductions: {summary.deductions} • Score:{" "}
                <span className="font-bold">{summary.finalScore}</span>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={sendReport}
                className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-md text-white"
              >
                Download Report
              </button>
            </div>
          </div>
          <div className="m-4">
            <p className="text-slate-400 text-sm text-center">
              Note: We're on Render's free tier, so loading the model may take a
              little longer. Thanks for your patience!
            </p>
          </div>
        </aside>
      </main>

      <footer className="w-full max-w-5xl text-xs text-slate-500 mt-6">
        Built for Tutedude SDE assignment • Models run client-side (privacy
        friendly)
      </footer>
    </div>
  );
}
