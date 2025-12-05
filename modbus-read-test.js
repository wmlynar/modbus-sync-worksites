// modbus-one-input-test.js
//
// Minimal Modbus test: read discrete inputs and print raw data array.
//
// Adjust IP, PORT, SLAVE_ID, OFFSET and LENGTH if needed.
// Usage:
//   node modbus-one-input-test.js

const ModbusRTU = require("modbus-serial");

// --- CONFIG ---
const IP          = "10.6.44.70";
const PORT        = 502;
const SLAVE_ID    = 255;
const OFFSET      = 0;   // starting discrete input address
const LENGTH      = 16;  // how many inputs to read
const INTERVAL_MS = 1000;

async function main() {
  const client = new ModbusRTU();
  client.setTimeout(1000); // 1s timeout

  try {
    console.log(`Connecting to Modbus TCP ${IP}:${PORT} (slaveId=${SLAVE_ID})...`);

    await new Promise((resolve, reject) => {
      client.connectTCP(IP, { port: PORT }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    client.setID(SLAVE_ID);

    console.log(
      `Connected. Reading discrete inputs from offset=${OFFSET}, length=${LENGTH} ` +
      `every ${INTERVAL_MS} ms. Press Ctrl+C to stop.`
    );

    setInterval(async () => {
      try {
        const res = await client.readDiscreteInputs(OFFSET, LENGTH);
        console.log("readDiscreteInputs data:", res && res.data);
      } catch (err) {
        console.error(
          "Error in readDiscreteInputs:",
          err && err.message ? err.message : err
        );
      }
    }, INTERVAL_MS);
  } catch (err) {
    console.error(
      "Error while connecting to Modbus:",
      err && err.message ? err.message : err
    );
    try { client.close(); } catch (_) {}
  }
}

main().catch((err) => {
  console.error("Fatal error in main():", err && err.stack ? err.stack : err);
});
