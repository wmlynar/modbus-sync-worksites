// modbus-sync-worksites.js
//
// Synchronize RDS worksites (FILLED / EMPTY) based on Modbus discrete inputs.
// Each site has:
//   - Modbus mapping (ip, port, slaveId, offset)
//   - default logical state (EMPTY / FILLED)
// Debounce:
//   - state stays "default" unless sensor is stably opposite to default for FILL_DEBOUNCE_MS.

const { APIClient } = require("./api-client");
const ModbusRTU = require("modbus-serial");

// --- DEBUG LOGGING -----------------------------------------------------------

const DEBUG_LOG = false;

function dlog(...args) {
  if (DEBUG_LOG) console.log(...args);
}

// --- GLOBAL ERROR HANDLERS ---------------------------------------------------

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err && err.stack ? err.stack : err);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err && err.stack ? err.stack : err);
});

// --- RDS CONFIG --------------------------------------------------------------

const RDS_HOST = "http://10.6.44.2:8080";
const RDS_USER = "admin";
const RDS_PASS = "123456";
const RDS_LANG = "en";

// --- MODBUS CONFIG -----------------------------------------------------------

const MODBUS_REQUEST_TIMEOUT_MS = 1000; // timeout of a single Modbus request (ms)
const POLL_INTERVAL_MS         = 500;  // how often we run syncOnce (ms)
const RECONNECT_BACKOFF_MS     = 5000; // min time between connect attempts (per group)

// --- DEBOUNCE CONFIG ---------------------------------------------------------

const FILL_DEBOUNCE_MS = 2000; // ms of stable opposite signal to accept change

// --- LOGICAL STATES ----------------------------------------------------------

const EMPTY  = "EMPTY";
const FILLED = "FILLED";

// --- WORKSITE -> MODBUS MAPPING ---------------------------------------------
//
// offset = Modbus discrete input address / index
//
// default:
//   - what state we assume when:
//       * Modbus is down
//       * debounce time is not yet satisfied
//
// Examples:
//   - pick locations: default = EMPTY  – assume nothing to pick until sensor confirms,
//   - drop locations: default = FILLED – assume you cannot drop until sensor confirms empty.

const SITES = [
  { siteId: "PICK-01", ip: "10.6.44.70", port: 502, slaveId: 255, offset: 9, default: EMPTY },
  // { siteId: "DROP-01", ip: "10.6.44.70", port: 502, slaveId: 255, offset: 11, default: FILLED },
];

// --- CONFIG VALIDATION -------------------------------------------------------

function validateConfig() {
  const ids = new Set();
  for (const s of SITES) {
    if (!s.siteId || typeof s.siteId !== "string") {
      throw new Error(`Invalid siteId in SITES: ${JSON.stringify(s)}`);
    }
    if (ids.has(s.siteId)) {
      throw new Error(`Duplicate siteId in SITES: ${s.siteId}`);
    }
    ids.add(s.siteId);

    if (!Number.isInteger(s.offset) || s.offset < 0) {
      throw new Error(`Invalid offset for ${s.siteId}: ${s.offset}`);
    }

    if (![EMPTY, FILLED].includes(s.default)) {
      throw new Error(`Invalid default state for ${s.siteId}: ${s.default}`);
    }
  }
}

validateConfig();

// --- GROUP SITES BY MODBUS CONNECTION ---------------------------------------
//
// group = { key, ip, port, slaveId, sites[], minOffset, length }

function groupSitesByConnection(sites) {
  const map = new Map();

  for (const s of sites) {
    const key = `${s.ip}:${s.port}:${s.slaveId}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        ip: s.ip,
        port: s.port,
        slaveId: s.slaveId,
        sites: [],
        minOffset: s.offset,
        maxOffset: s.offset,
      };
      map.set(key, g);
    }
    g.sites.push(s);
    if (s.offset < g.minOffset) g.minOffset = s.offset;
    if (s.offset > g.maxOffset) g.maxOffset = s.offset;
  }

  return Array.from(map.values()).map((g) => ({
    key: g.key,
    ip: g.ip,
    port: g.port,
    slaveId: g.slaveId,
    sites: g.sites,
    minOffset: g.minOffset,
    length: g.maxOffset - g.minOffset + 1,
  }));
}

const GROUPS = groupSitesByConnection(SITES);

// --- MODBUS STATE: one per group --------------------------------------------
//
// modbusStates[group.key] = { client|null, lastAttemptMs }

const modbusStates = new Map();

// --- DEBOUNCE STATE PER WORKSITE --------------------------------------------
//
// debounceStates[siteId] = {
//   lastOppositeStartTs: number | null,
//   effectiveVal: boolean (true=FILLED, false=EMPTY)
// }

const debounceStates = new Map();

// --- HELPERS -----------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultToBool(def) {
  return def === FILLED;
}

// Update debounced value for a single site.
// rawVal = raw sensor bit (true/false).
function updateDebouncedState(site, rawVal, now) {
  const siteId     = site.siteId;
  const defaultVal = defaultToBool(site.default);
  const opposite   = !defaultVal;

  let st = debounceStates.get(siteId);
  if (!st) {
    st = { lastOppositeStartTs: null, effectiveVal: defaultVal };
    debounceStates.set(siteId, st);
  }

  if (rawVal === defaultVal) {
    // Sensor agrees with default -> immediately back to default.
    st.lastOppositeStartTs = null;
    st.effectiveVal = defaultVal;
  } else {
    // Sensor suggests opposite state.
    if (st.lastOppositeStartTs === null) {
      // First time we see opposite signal.
      st.lastOppositeStartTs = now;
      st.effectiveVal = defaultVal; // still default until delay passes
    } else if (now - st.lastOppositeStartTs >= FILL_DEBOUNCE_MS) {
      // Opposite signal held long enough -> accept change.
      st.effectiveVal = opposite;
    }
  }

  return st.effectiveVal;
}

function resetDebounceForSites(sites) {
  for (const s of sites) {
    debounceStates.delete(s.siteId);
  }
}

// --- MODBUS: connect + read with simple backoff ------------------------------
//
// Returns:
//   { status: "ok", inputs: boolean[] }
//   { status: "backoff" }
//   { status: "error", message: string }

async function readInputsForGroup(group) {
  let state = modbusStates.get(group.key);
  const now = Date.now();

  if (!state) {
    state = { client: null, lastAttemptMs: 0 };
    modbusStates.set(group.key, state);
  }

  // 1) Need client: try to (re)connect, but respect backoff.
  if (!state.client) {
    const sinceLast = now - state.lastAttemptMs;

    if (state.lastAttemptMs !== 0 && sinceLast < RECONNECT_BACKOFF_MS) {
      // Still waiting before next connect attempt.
      dlog(
        `[Modbus] Group ${group.key}: reconnect backoff ${sinceLast}ms < ${RECONNECT_BACKOFF_MS}ms`
      );
      return { status: "backoff" };
    }

    state.lastAttemptMs = now;

    try {
      const client = new ModbusRTU();
      client.setTimeout(MODBUS_REQUEST_TIMEOUT_MS);

      await new Promise((resolve, reject) => {
        client.connectTCP(group.ip, { port: group.port }, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });

      client.setID(group.slaveId);
      state.client = client;

      dlog(`Connected to Modbus ${group.key}`);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      // Connection failed, keep client=null, we will backoff next time.
      return {
        status: "error",
        message: `connect failed: ${msg}`,
      };
    }
  }

  // 2) We have client: read discrete inputs.
  try {
    const startAddr  = group.minOffset;
    const readLength = group.sites.length === 1 ? 1 : group.length;

    dlog(
      `[MODBUS-REQ] ${group.key} readDiscreteInputs(addr=${startAddr}, len=${readLength})`
    );

    const raw = await new Promise((resolve, reject) => {
      state.client.readDiscreteInputs(
        startAddr,
        readLength,
        (err, data) => {
          if (err) return reject(err);
          resolve(data);
        }
      );
    });

    const inputs = raw && Array.isArray(raw.data) ? raw.data : null;
    if (!inputs) {
      return {
        status: "error",
        message: "invalid readDiscreteInputs response format",
      };
    }

    const maxAddr = startAddr + inputs.length - 1;
    dlog(
      `[MODBUS-RESP] ${group.key} len=${inputs.length} inputs[${startAddr}..${maxAddr}] =`,
      inputs
    );

    return { status: "ok", inputs };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);

    // Reading failed: close client, so next call will reconnect (with backoff).
    try {
      if (state.client) state.client.close();
    } catch (_) {}
    state.client = null;
    state.lastAttemptMs = Date.now();

    return {
      status: "error",
      message: `readDiscreteInputs failed: ${msg}`,
    };
  }
}

// --- RDS: write worksite state ----------------------------------------------
//
// filledBool: true = FILLED, false = EMPTY

async function writeWorksiteState(api, site, filledBool, context) {
  try {
    if (filledBool) {
      await api.setWorkSiteFilled(site.siteId);
    } else {
      await api.setWorkSiteEmpty(site.siteId);
    }

    // Success is debug-level info.
    dlog(
      `[RDS] Worksite ${site.siteId} => ${filledBool ? "FILLED" : "EMPTY"} (${context})`
    );
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error(
      `[RDS] Failed to update worksite ${site.siteId} (${context}): ${msg}`
    );
  }
}

// --- Apply default state (used on Modbus error / missing value) --------------

async function setSitesDefault(api, sites, context) {
  for (const s of sites) {
    const assumeFilled = defaultToBool(s.default);
    const reason = `set to default (${s.default}) because ${context}`;
    await writeWorksiteState(api, s, assumeFilled, reason);
  }
}

// --- ONE SYNC CYCLE ----------------------------------------------------------

async function syncOnce(api) {
  if (!api.sessionId) {
    try {
      await api.login();
      dlog("[RDS] Initial login succeeded.");
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error("[RDS] Initial login failed:", msg);
      // Continue – APIClient may retry on its own.
    }
  }

  for (const group of GROUPS) {
    const { sites, minOffset } = group;

    const result = await readInputsForGroup(group);

    if (result.status === "backoff") {
      // We are in reconnect backoff window -> keep current RDS state, do nothing.
      continue;
    }

    if (result.status === "error") {
      // Real communication problem -> log once per cycle and use defaults.
      console.error(
        `[Modbus] Group ${group.key}: communication error, using default states. Details: ${result.message}`
      );
      resetDebounceForSites(sites);
      await setSitesDefault(api, sites, `Modbus error for group ${group.key}: ${result.message}`);
      continue;
    }

    // status === "ok"
    const inputs = result.inputs;

    for (const s of sites) {
      const idx = s.offset - minOffset;
      const rawVal = inputs[idx];

      if (typeof rawVal === "undefined") {
        const ctx =
          `Missing Modbus input value (idx=${idx}) for site ${s.siteId}, ` +
          `probable configuration error (offset=${s.offset}). Using default state (${s.default}).`;
        console.error(ctx);
        resetDebounceForSites([s]);
        await setSitesDefault(api, [s], ctx);
        continue;
      }

      const now = Date.now();
      const effectiveBool = updateDebouncedState(s, !!rawVal, now);

      dlog(
        `[DEBOUNCE] siteId=${s.siteId} raw=${!!rawVal} default=${s.default} -> debounced=${effectiveBool ? "FILLED" : "EMPTY"}`
      );

      await writeWorksiteState(
        api,
        s,
        effectiveBool,
        "based on debounced Modbus signal"
      );
    }
  }
}

// --- CLEANUP ON EXIT ---------------------------------------------------------

function closeAllModbusClients() {
  for (const [key, state] of modbusStates.entries()) {
    if (!state || !state.client) continue;
    try {
      state.client.close();
      dlog(`Closed Modbus connection ${key}`);
    } catch (_) {
      // ignore
    }
  }
}

process.on("SIGINT", () => {
  console.log("SIGINT – closing Modbus clients and exiting...");
  closeAllModbusClients();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM – closing Modbus clients and exiting...");
  closeAllModbusClients();
  process.exit(0);
});

// --- MAIN LOOP ---------------------------------------------------------------

async function mainLoop() {
  const api = new APIClient(RDS_HOST, RDS_USER, RDS_PASS, RDS_LANG);

  dlog(`Starting synchronization loop (every ${POLL_INTERVAL_MS} ms)`);
  dlog(`Number of Modbus groups: ${GROUPS.length}`);

  while (true) {
    const start = Date.now();

    try {
      await syncOnce(api);
    } catch (err) {
      const msg = err && err.stack ? err.stack : err;
      console.error("Global error in syncOnce:", msg);
    }

    const elapsed = Date.now() - start;
    const wait = Math.max(POLL_INTERVAL_MS - elapsed, 0);
    if (wait > 0) {
      await sleep(wait);
    }
  }
}

// --- START -------------------------------------------------------------------

mainLoop().catch((err) => {
  const msg = err && err.stack ? err.stack : err;
  console.error("Fatal error in mainLoop:", msg);
  closeAllModbusClients();
});
