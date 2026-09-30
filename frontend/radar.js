/**
 * Radar canvas renderer — semi-circle (0-180 degree) PPI scope, matching
 * the HC-SR04's actual scanned sector. A full 360-degree bezel would
 * misrepresent the hardware's real coverage, so the scope area itself
 * is a half-moon, with the compass bezel only spanning the same arc.
 *
 * The sweep angle is smoothly interpolated every animation frame toward
 * the last angle reported by the ESP32, rather than jumping straight to
 * each new value — this removes the stutter that showed up when the
 * sensor's no-echo timeout slowed down the data rate.
 */

const canvas = document.getElementById("radarCanvas");
const ctx = canvas.getContext("2d");

const MAX_RANGE_CM = 40;
const ALERT_RANGE_CM = 20;
const RING_COUNT = 4;
const SWEEP_SMOOTHING = 0.15;

const PHOSPHOR = "61, 255, 122";
const AMBER = "255, 179, 0";
const RED = "255, 50, 50";

let targetAngle = 90;
let displayAngle = 90;
let lastDisplayAngle = 90;
let currentDistance = 0;
let contacts = new Array(181).fill(null); // contacts[angle] = { distance, createdOnPass }

// Increments every time the sweep beam reverses direction (hits either
// end of the 0-180 sector). A contact is only erased once the beam has
// swept back over its angle on a LATER pass than the one that created
// it — this is what makes it disappear exactly when the line "comes
// back", not after some fixed timer.
let sweepPassNumber = 0;
let currentSweepDirection = 1; // 1 = increasing angle, -1 = decreasing

let lastUpdateTimes = [];

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * devicePixelRatio;
  canvas.height = rect.height * devicePixelRatio;
  canvas.style.width = rect.width + "px";
  canvas.style.height = rect.height + "px";
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

/**
 * Origin sits at the bottom-center of the available area, with the scope
 * opening upward across a 180-degree arc — matching how the servo+sensor
 * physically sweep in front of the device.
 */
function scopeGeometry() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const originX = w / 2;
  const originY = h - 60;
  // Use nearly all available width and height, leaving room only for the
  // compass bezel ring and its labels on the outside.
  const radius = Math.min(w / 2 - 34, h - 90);
  return { originX, originY, radius };
}

function polarToXY(angleDeg, distanceCm, originX, originY, radius) {
  const r = (distanceCm / MAX_RANGE_CM) * radius;
  const rad = (angleDeg * Math.PI) / 180;
  const x = originX + r * Math.cos(rad);
  const y = originY - r * Math.sin(rad);
  return { x, y };
}

/**
 * Compass-style bezel, but only across the actual 0-180 degree scanned
 * arc — the sensor's real field of coverage, not a decorative full circle.
 */
function drawCompassBezel(originX, originY, radius) {
  const bezelR = radius + 22;

  ctx.strokeStyle = `rgba(${PHOSPHOR}, 0.55)`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(originX, originY, bezelR, Math.PI, 2 * Math.PI);
  ctx.stroke();

  for (let deg = 0; deg <= 180; deg += 2) {
    const isMajor = deg % 30 === 0;
    const isMid = deg % 10 === 0;

    const rad = (deg * Math.PI) / 180;
    const tickLen = isMajor ? 14 : isMid ? 8 : 4;
    const outerR = bezelR;
    const innerR = bezelR - tickLen;

    ctx.strokeStyle = `rgba(${PHOSPHOR}, ${isMajor ? 0.75 : isMid ? 0.4 : 0.2})`;
    ctx.lineWidth = isMajor ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(
      originX + innerR * Math.cos(rad),
      originY - innerR * Math.sin(rad),
    );
    ctx.lineTo(
      originX + outerR * Math.cos(rad),
      originY - outerR * Math.sin(rad),
    );
    ctx.stroke();

    if (isMajor) {
      ctx.fillStyle = `rgba(${PHOSPHOR}, 0.8)`;
      ctx.font = "11px 'Share Tech Mono', monospace";
      const labelR = bezelR + 16;
      const lx = originX + labelR * Math.cos(rad);
      const ly = originY - labelR * Math.sin(rad);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${deg}`, lx, ly);
    }
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // Baseline across the flat edge of the semi-circle
  ctx.strokeStyle = `rgba(${PHOSPHOR}, 0.5)`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(originX - bezelR, originY);
  ctx.lineTo(originX + bezelR, originY);
  ctx.stroke();
}

function drawRangeRings(originX, originY, radius) {
  for (let i = 1; i <= RING_COUNT; i++) {
    const r = (radius * i) / RING_COUNT;
    ctx.strokeStyle = `rgba(${PHOSPHOR}, ${i === RING_COUNT ? 0.5 : 0.28})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(originX, originY, r, Math.PI, 2 * Math.PI);
    ctx.stroke();
  }

  for (let i = 1; i <= 12; i++) {
    const r = (radius * i) / 12;
    ctx.strokeStyle = `rgba(${PHOSPHOR}, 0.06)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(originX, originY, r, Math.PI, 2 * Math.PI);
    ctx.stroke();
  }

  // Spokes at 30-degree intervals within the scanned sector
  for (let deg = 0; deg <= 180; deg += 30) {
    const rad = (deg * Math.PI) / 180;
    ctx.strokeStyle = `rgba(${PHOSPHOR}, 0.08)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(originX, originY);
    ctx.lineTo(
      originX + radius * Math.cos(rad),
      originY - radius * Math.sin(rad),
    );
    ctx.stroke();
  }

  // Distance labels placed directly on each ring, along the 150-degree
  // spoke where there's reliably open space (upper-left quadrant),
  // clearly inside the scope rather than crowding the baseline.
  const labelDeg = 150;
  const labelRad = (labelDeg * Math.PI) / 180;
  ctx.save();
  for (let i = 1; i <= RING_COUNT; i++) {
    const r = (radius * i) / RING_COUNT;
    const lx = originX + r * Math.cos(labelRad);
    const ly = originY - r * Math.sin(labelRad);

    // Small dark backing so the label reads clearly over the grid lines
    const text = `${(MAX_RANGE_CM * i) / RING_COUNT}CM`;
    ctx.font = "11px 'Share Tech Mono', monospace";
    const metrics = ctx.measureText(text);
    ctx.fillStyle = "rgba(0, 10, 4, 0.75)";
    ctx.fillRect(lx - metrics.width / 2 - 4, ly - 8, metrics.width + 8, 16);

    ctx.fillStyle = `rgba(${PHOSPHOR}, 0.85)`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, lx, ly);
  }
  ctx.restore();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // Center hub
  ctx.beginPath();
  ctx.arc(originX, originY, 4, 0, 2 * Math.PI);
  ctx.fillStyle = `rgba(${PHOSPHOR}, 0.85)`;
  ctx.fill();
}

function drawActiveSectorTint(originX, originY, radius) {
  ctx.beginPath();
  ctx.moveTo(originX, originY);
  ctx.arc(originX, originY, radius, Math.PI, 2 * Math.PI, false);
  ctx.closePath();
  ctx.fillStyle = `rgba(${PHOSPHOR}, 0.025)`;
  ctx.fill();
}

function sweepDirectionSign() {
  return displayAngle >= lastDisplayAngle ? -1 : 1;
}

function drawSweepBeam(originX, originY, radius) {
  const rad = (displayAngle * Math.PI) / 180;

  const grad = ctx.createRadialGradient(
    originX,
    originY,
    0,
    originX,
    originY,
    radius,
  );
  grad.addColorStop(0, `rgba(${PHOSPHOR}, 0.3)`);
  grad.addColorStop(1, `rgba(${PHOSPHOR}, 0)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(originX, originY);
  ctx.arc(
    originX,
    originY,
    radius,
    Math.PI - rad - 0.1,
    Math.PI - rad + 0.1,
    false,
  );
  ctx.closePath();
  ctx.fill();

  const dirSign = sweepDirectionSign();
  for (let i = 1; i <= 30; i++) {
    const trailAngle = displayAngle + dirSign * i * 0.9;
    if (trailAngle < 0 || trailAngle > 180) continue;
    const trailRad = (trailAngle * Math.PI) / 180;
    const alpha = Math.max(0, 0.35 - i * 0.012);
    if (alpha <= 0) continue;
    ctx.strokeStyle = `rgba(${PHOSPHOR}, ${alpha})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(originX, originY);
    ctx.lineTo(
      originX + radius * Math.cos(trailRad),
      originY - radius * Math.sin(trailRad),
    );
    ctx.stroke();
  }

  ctx.strokeStyle = `rgba(${PHOSPHOR}, 1)`;
  ctx.shadowColor = `rgba(${PHOSPHOR}, 0.9)`;
  ctx.shadowBlur = 12;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(originX, originY);
  ctx.lineTo(
    originX + radius * Math.cos(rad),
    originY - radius * Math.sin(rad),
  );
  ctx.stroke();
  ctx.shadowBlur = 0;
}

/**
 * Draws each tracked contact with brightness stepped through discrete
 * stages as it ages, rather than a continuous smooth fade. Real radar
 * blips read as deliberate, distinct states (fresh / aging / stale)
 * rather than a soft blur dissolving away — this stepped approach reads
 * as more intentional and instrument-like.
 */
function drawContacts(originX, originY, radius) {
  for (let a = 0; a <= 180; a++) {
    const c = contacts[a];
    if (!c) continue;

    const { x, y } = polarToXY(a, c.distance, originX, originY, radius);
    const isClose = c.distance < ALERT_RANGE_CM;
    const color = isClose ? RED : AMBER;

    // Contacts are always drawn at full strength — there is no time-based
    // fade. A contact is either present (because the current sweep pass
    // has detected it and no later pass has crossed it yet) or it has
    // already been erased by markSweptContacts(). This matches how a real
    // radar's sweep works: a return is bright until the beam comes back
    // around, then it's simply gone.
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, 2 * Math.PI);
    ctx.fillStyle = `rgba(${color}, 0.95)`;
    ctx.shadowColor = `rgba(${color}, 0.9)`;
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;

    if (Math.round(displayAngle) === a) {
      ctx.strokeStyle = `rgba(${color}, 0.95)`;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - 9, y - 9, 18, 18);

      ctx.fillStyle = `rgba(${color}, 0.95)`;
      ctx.font = "10px 'Share Tech Mono', monospace";
      ctx.fillText(`${c.distance.toFixed(0)}CM ${a}°`, x + 12, y + 3);
    }
  }
}

/**
 * Erases any contact whose creating pass is older than the sweep's
 * current pass — i.e., the beam has completed a full reversal and swept
 * back over that bearing at least once since the contact was recorded.
 * This is a pure counter comparison, not time-based, so it can't ever
 * erase a contact on the very pass that created it (created-on-pass N
 * is never less than current pass N), and it can't wait an arbitrary
 * fixed duration either — erasure happens exactly when the beam returns.
 */
function eraseContactsFromOldPasses() {
  for (let a = 0; a <= 180; a++) {
    const c = contacts[a];
    if (!c) continue;
    if (c.createdOnPass < sweepPassNumber) {
      contacts[a] = null;
    }
  }
}

function render() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  lastDisplayAngle = displayAngle;
  // Adaptive smoothing: a big jump in target angle (typically a direction
  // reversal at the sector's edges) eases more gently than small, steady
  // steps during normal sweeping — this is what removes the jerky snap
  // that a single fixed smoothing factor produced at the turnaround points.
  const angleGap = Math.abs(targetAngle - displayAngle);
  const adaptiveSmoothing =
    angleGap > 8 ? SWEEP_SMOOTHING * 0.5 : SWEEP_SMOOTHING;
  displayAngle += (targetAngle - displayAngle) * adaptiveSmoothing;

  // Detect a direction reversal (the beam hitting either end of the
  // sector and turning back) and bump the pass counter exactly once per
  // reversal. Any contact created on an earlier pass than this is now
  // eligible for erasure — checked by angle as the beam actually crosses it.
  const newDirection = displayAngle >= lastDisplayAngle ? 1 : -1;
  if (newDirection !== currentSweepDirection) {
    sweepPassNumber++;
    currentSweepDirection = newDirection;
  }

  // Erase contacts at angles the beam has just crossed, if those contacts
  // were created on an earlier pass than the current one.
  const lo = Math.floor(Math.min(lastDisplayAngle, displayAngle));
  const hi = Math.ceil(Math.max(lastDisplayAngle, displayAngle));
  for (let a = lo; a <= hi; a++) {
    if (a < 0 || a > 180) continue;
    const c = contacts[a];
    if (c && c.createdOnPass < sweepPassNumber) {
      contacts[a] = null;
    }
  }

  const { originX, originY, radius } = scopeGeometry();

  drawActiveSectorTint(originX, originY, radius);
  drawRangeRings(originX, originY, radius);
  drawCompassBezel(originX, originY, radius);
  drawContacts(originX, originY, radius);
  drawSweepBeam(originX, originY, radius);

  requestAnimationFrame(render);
}
requestAnimationFrame(render);

// ---------------------------------------------------------------
// Clock
// ---------------------------------------------------------------
function updateClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  document.getElementById("clockTime").textContent = `${hh}:${mm}:${ss}`;
}
setInterval(updateClock, 1000);
updateClock();

// ---------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------
const socket = io();

const ledLink = document.getElementById("ledLink");
const ledAlert = document.getElementById("ledAlert");
const readoutAngle = document.getElementById("readoutAngle");
const readoutDistance = document.getElementById("readoutDistance");
const readoutStatus = document.getElementById("readoutStatus");
const vrmBearing = document.getElementById("vrmBearing");
const vrmRange = document.getElementById("vrmRange");
const contactLog = document.getElementById("contactLog");
const sysSweep = document.getElementById("sysSweep");
const sysPort = document.getElementById("sysPort");
const trackCount = document.getElementById("trackCount");
const sweepRateTag = document.getElementById("sweepRateTag");

let lastAngleForSweepDir = 15;
let recentContactLog = [];
let lastSweepTime = performance.now();
let lastSweepAngle = 15;

socket.on("hardware-status", ({ connected, port }) => {
  ledLink.classList.toggle("on", connected);
  if (port) sysPort.textContent = port;
});

socket.on("radar-data", ({ angle, distance }) => {
  targetAngle = angle;
  currentDistance = distance;

  const now = performance.now();
  const dt = (now - lastSweepTime) / 1000;
  if (dt > 0) {
    const rate = Math.abs(angle - lastSweepAngle) / dt;
    sweepRateTag.textContent = `${rate.toFixed(0)} deg/s`;
  }
  lastSweepTime = now;
  lastSweepAngle = angle;

  sysSweep.textContent = angle > lastAngleForSweepDir ? "FWD" : "REV";
  lastAngleForSweepDir = angle;

  lastUpdateTimes.push(now);
  lastUpdateTimes = lastUpdateTimes.filter((t) => now - t < 1000);

  const isClose = distance > 0 && distance < ALERT_RANGE_CM;
  ledAlert.classList.toggle("on", isClose);

  if (distance > 0 && distance <= MAX_RANGE_CM) {
    contacts[angle] = {
      distance,
      lastSeen: now,
      createdOnPass: sweepPassNumber,
    };

    recentContactLog.unshift({ angle, distance, isClose });
    recentContactLog = recentContactLog.slice(0, 6);
    renderContactLog();

    vrmBearing.textContent = `${angle}°`;
    vrmRange.textContent = distance.toFixed(1);
  }

  trackCount.textContent = String(contacts.filter(Boolean).length).padStart(
    3,
    "0",
  );

  readoutAngle.textContent = `${angle}°`;
  if (distance > 0 && distance <= MAX_RANGE_CM) {
    readoutDistance.textContent = `${distance.toFixed(1)} cm`;
    readoutDistance.classList.toggle("alert", isClose);
    readoutStatus.textContent = isClose ? "CONTACT" : "TRACKING";
    readoutStatus.classList.toggle("alert", isClose);
  } else {
    readoutDistance.textContent = "-- cm";
    readoutDistance.classList.remove("alert");
    readoutStatus.textContent = "SCANNING";
    readoutStatus.classList.remove("alert");
  }
});

function renderContactLog() {
  if (recentContactLog.length === 0) {
    contactLog.innerHTML =
      '<div class="contact-row"><span class="empty">awaiting contact...</span></div>';
    return;
  }

  contactLog.innerHTML = recentContactLog
    .map(
      (c) => `
      <div class="contact-row ${c.isClose ? "alert-row" : ""}">
        <span>${c.angle}°</span>
        <span>${c.distance.toFixed(1)} cm</span>
      </div>
    `,
    )
    .join("");
}
