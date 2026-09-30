/**
 * Radar Dashboard Backend — Local Serial Version
 * ------------------------------------------------
 * Reads "Angle:X,Distance:Y" lines from the ESP32 over USB serial,
 * and broadcasts them to all connected browser clients over WebSocket.
 *
 * Architecture:
 *   ESP32 --(USB Serial)--> this server --(WebSocket)--> Browser (localhost)
 */

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");

const PORT = process.env.PORT || 3000;

// ---- Set this to match your ESP32's COM port ----
// Windows example: "COM10"   |   Linux example: "/dev/ttyUSB0"   |   Mac example: "/dev/cu.usbserial-XXXX"
const SERIAL_PORT_NAME = process.env.SERIAL_PORT || "COM10";
const BAUD_RATE = 115200;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

app.use(express.static(path.join(__dirname, "..", "frontend")));

// ---------------------------------------------------------------
// Serial connection state
// ---------------------------------------------------------------
let serialPort = null;
let parser = null;
let isConnected = false;

function connectSerial() {
  serialPort = new SerialPort(
    { path: SERIAL_PORT_NAME, baudRate: BAUD_RATE, autoOpen: false },
    (err) => {
      if (err) {
        console.error(`[serial] failed to configure port: ${err.message}`);
      }
    },
  );

  parser = serialPort.pipe(new ReadlineParser({ delimiter: "\r\n" }));

  serialPort.open((err) => {
    if (err) {
      console.error(
        `[serial] could not open ${SERIAL_PORT_NAME}: ${err.message}`,
      );
      isConnected = false;
      io.emit("hardware-status", { connected: false });
      setTimeout(connectSerial, 3000);
      return;
    }
    console.log(
      `[serial] connected on ${SERIAL_PORT_NAME} @ ${BAUD_RATE} baud`,
    );
    isConnected = true;
    io.emit("hardware-status", { connected: true });
  });

  serialPort.on("close", () => {
    console.warn("[serial] port closed, will retry...");
    isConnected = false;
    io.emit("hardware-status", { connected: false });
    setTimeout(connectSerial, 3000);
  });

  serialPort.on("error", (err) => {
    console.error(`[serial] error: ${err.message}`);
  });

  parser.on("data", (line) => {
    const reading = parseRadarLine(line);
    if (reading) {
      io.emit("radar-data", reading);
    }
  });
}

/**
 * Parses a line like "Angle:87,Distance:23.40" into { angle, distance }.
 * Returns null for malformed lines instead of throwing, so one bad
 * line from the sensor never takes down the pipe.
 */
function parseRadarLine(line) {
  const match = line.match(/Angle:(\d+),Distance:([\d.]+)/);
  if (!match) return null;

  const angle = parseInt(match[1], 10);
  const distance = parseFloat(match[2]);

  if (Number.isNaN(angle) || Number.isNaN(distance)) return null;
  if (angle < 0 || angle > 180) return null;

  return { angle, distance, timestamp: Date.now() };
}

io.on("connection", (socket) => {
  console.log("[client] browser connected");
  socket.emit("hardware-status", { connected: isConnected });

  socket.on("disconnect", () => {
    console.log("[client] browser disconnected");
  });
});

server.listen(PORT, () => {
  console.log(`[server] radar dashboard running at http://localhost:${PORT}`);
  connectSerial();
});
