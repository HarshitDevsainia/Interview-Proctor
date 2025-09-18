# 🎥 AI-Powered Online Proctoring System

An **AI-powered proctoring panel** for online interviews and exams.  
It monitors **face, gaze, objects, drowsiness, and background audio** in real-time and generates **detailed integrity reports**.

---

## ✨ Features

- **Face & Gaze Detection**

  - Detects if the candidate is present.
  - Logs when they look away or go missing.
  - Detects multiple faces.

- **Suspicious Object Detection**

  - Powered by **TensorFlow COCO-SSD**.
  - Detects phones, books, laptops, remotes, and other restricted items.

- **Drowsiness Detection (EAR - Eye Aspect Ratio)**

  - Monitors eye closure duration.
  - Flags drowsiness if eyes remain closed for more than 2 seconds.

- **Background Audio Monitoring**

  - Uses Web Audio API with FFT analysis.
  - Detects unusual background noise or voices.

- **Session Recording & Reports**
  - Records video/audio of the candidate.
  - Generates **detailed PDF reports** with:
    - Timestamps
    - Logs of suspicious events
    - Final integrity score
  - Option to **download video recording**.
  - Reports can be sent to backend (`/api/proctoring/save-report`).

---

## 🏗 Tech Stack

### 🔹 Frontend

- React + Tailwind CSS
- MediaPipe FaceMesh
- TensorFlow COCO-SSD
- Web Audio API (FFT for sound detection)
- jsPDF (PDF report generation)

### 🔹 Backend

- Node.js + Express.js
- MongoDB (for storing reports & logs)

---

## ⚙️ Installation

### 1️⃣ Clone the Repository

```bash
git clone https://github.com/HarshitDevsainia/Interview-Proctor.git
cd Interview-Proctor
```

### 2️⃣ Setup Frontend

```bash

cd Frontend

npm install

npm run dev

Runs on: http://localhost:5173

```

### 2️⃣ Setup Backend

```bash

cd Backend

npm install

npm run dev

Runs on: http://localhost:5000

```

5000

### 🚀 Usage

Start frontend and backend servers.

Open the app in browser (http://localhost:5173).

Allow camera and microphone access.

The system starts monitoring automatically:

- 👀 Face tracking & gaze detection

- 📱 Object detection (phone, book, etc.)

- 😴 Drowsiness detection

- 🎤 Audio monitoring

At session end, click End Interview to:

Download recording

Generate & download PDF report

Save report to backend