// modbus-sync-worksites.js
//
// Synchronization of RDS work sites (FILLED/EMPTY) based on Modbus discrete inputs,
// with debouncing and per-site default state for error / unstable signal cases.

const { APIClient } = require("./api-client");
const ModbusRTU = require("modbus-serial");

// --- LOGGING (DEBUG) ---
//
// Set DEBUG_LOG = false in production to avoid verbose logs.
// Errors (console.error) are always logged.

const DEBUG_LOG = false;

function dlog(...args) {
  if (DEBUG_LOG) console.log(...args);
}

// --- GLOBAL ERROR HANDLERS ---

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err && err.stack ? err.stack : err);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err && err.stack ? err.stack : err);
});

// --- RDS CONFIG (hard-coded for now) ---

const RDS_HOST = "http://10.6.44.2:8080";
const RDS_USER = "admin";
const RDS_PASS = "123456";
const RDS_LANG = "en";

// --- MODBUS CONFIG ---

// Timeout for a single Modbus request (in ms).
// After this time readDiscreteInputs will fail and we handle the error.
const MODBUS_REQUEST_TIMEOUT_MS = 1000; // 1 second

// --- MAIN LOOP CONFIG ---

const POLL_INTERVAL_MS = 500;       // how often we run a full sync
const RECONNECT_BACKOFF_MS = 5000;  // minimum time between reconnect attempts per Modbus group

// --- DEBOUNCE CONFIG ---
//
// How long (ms) the Modbus signal must stay opposite to the default state
// to be accepted as a stable change.
// If this condition is not met, the worksite stays in the default state.

const FILL_DEBOUNCE_MS = 2000; // 2 seconds

// --- LOGICAL STATES ---

const EMPTY  = "EMPTY";
const FILLED = "FILLED";

// --- WORKSITE -> MODBUS MAPPING ---
//
// offset = Modbus discrete input address = index in readDiscreteInputs().data
//
// Fields:
//   siteId   – worksite identifier in RDS
//   ip, port – Modbus TCP address of the PLC
//   slaveId  – Modbus slave ID
//   offset   – discrete input address
//   default  – EMPTY / FILLED (default logical state for this site)
//
// Semantics of `default`:
//   - used when Modbus communication fails,
//   - used as the "safe" state when debouncing is not yet satisfied.
// Examples:
//   - pick locations: default = EMPTY  (assume nothing to pick until sensor confirms presence),
//   - drop locations: default = FILLED (assume you cannot drop until sensor confirms emptiness).

const SITES = [
  // PLC 10.6.44.70, slaveId 255 – example sites:
  { siteId: "PICK-01", ip: "10.6.44.70", port: 502, slaveId: 255, offset:  9, default: EMPTY  },
  // { siteId: "PICK-02", ip: "10.6.44.70", port: 502, slaveId: 255, offset: 10, default: EMPTY  },
  // { siteId: "DROP-01", ip: "10.6.44.70", port: 502, slaveId: 255, offset: 11, default: FILLED },
  // { siteId: "DROP-02", ip: "10.6.44.70", port: 502, slaveId: 255, offset: 12, default: FILLED },
];

// --- CONFIG VALIDATION ---
//
// Fail fast on startup if something is clearly wrong.

function validateConfig() {
  const siteIds = new Set();

  for (const s of SITES) {
    if (!s.siteId || typeof s.siteId !== "string") {
      throw new Error(`Invalid siteId in SITES: ${JSON.stringify(s)}`);
    }
    if (siteIds.has(s.siteId)) {
      throw new Error(`Duplicate siteId in SITES: ${s.siteId}`);
    }
    siteIds.add(s.siteId);

    if (!Number.isInteger(s.offset) || s.offset < 0) {
      throw new Error(`Invalid offset for ${s.siteId}: ${s.offset}`);
    }

    if (![EMPTY, FILLED].includes(s.default)) {
      throw new Error(`Invalid default state for ${s.siteId}: ${s.default}`);
    }
  }
}

validateConfig();

// --- GROUP SITES BY (ip, port, slaveId) ---

function groupSitesByConnection(sites) {
  const groupsMap = new Map();

  for (const s of sites) {
    const key = `${s.ip}:${s.port}:${s.slaveId}`;
    let g = groupsMap.get(key);
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
      groupsMap.set(key, g);
    }
    g.sites.push(s);
    if (s.offset < g.minOffset) g.minOffset = s.offset;
    if (s.offset > g.maxOffset) g.maxOffset = s.offset;
  }

  return Array.from(groupsMap.values()).map((g) => ({
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

// --- MODBUS STATE: key -> { client|null, lastAttempt } ---

const modbusStates = new Map();

// --- DEBOUNCE STATE PER WORKSITE ---
//
// siteId -> {
//   lastOppositeStartTs: number|null, // when we first saw raw != default
//   effectiveVal: boolean             // debounced logical state (true = FILLED, false = EMPTY)
// }

const siteDebounceStates = new Map();

// --- HELPERS ---

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Convert EMPTY/FILLED to boolean (true = FILLED, false = EMPTY)
function defaultToBool(defaultState) {
  return defaultState === FILLED;
}

// Debounce with respect to default:
//
// defaultBool = default logical state (true/false)
// rawVal      = raw Modbus bit (true = sensor sees "full")
//
// Rules:
//   - if rawVal === defaultBool → effectiveVal = defaultBool immediately,
//   - if rawVal !== defaultBool → only after FILL_DEBOUNCE_MS of continuous opposite
//                                 signal we switch effectiveVal to the opposite.
// That means:
//   - state stays "default" unless we have *stable* opposite signal,
//   - any glitches quickly pull us back to default.
//
// Examples:
//   - PICK (default=EMPTY): we need stable "full" to consider something present,
//   - DROP (default=FILLED): we need stable "empty" to consider it safe to drop.

function updateDebouncedState(site, rawVal, now) {
  const siteId = site.siteId;
  const defaultBool = defaultToBool(site.default);
  const oppositeBool = !defaultBool;

  let st = siteDebounceStates.get(siteId);
  if (!st) {
    st = {
      lastOppositeStartTs: null,
      effectiveVal: defaultBool,
    };
    siteDebounceStates.set(siteId, st);
  }

  if (rawVal === defaultBool) {
    // Back to default state (or still there).
    st.lastOppositeStartTs = null;
    st.effectiveVal = defaultBool;
  } else {
    // Raw signal is opposite to default.
    if (st.lastOppositeStartTs === null) {
      st.lastOppositeStartTs = now;
      st.effectiveVal = defaultBool; // still default until debounce time passes
    } else if (now - st.lastOppositeStartTs >= FILL_DEBOUNCE_MS) {
      st.effectiveVal = oppositeBool;
    }
    // if not enough time passed → keep current effectiveVal
  }

  return st.effectiveVal; // boolean: true = FILLED, false = EMPTY
}

function resetDebounceForSites(sites) {
  for (const s of sites) {
    siteDebounceStates.delete(s.siteId);
  }
}

// --- MODBUS: READ DISCRETE INPUTS FOR A GROUP WITH RECONNECT/BACKOFF ---

async function readInputsForGroup(group) {
  let state = modbusStates.get(group.key);
  const now = Date.now();

  if (!state) {
    state = { client: null, lastAttempt: 0 };
    modbusStates.set(group.key, state);
  }

  // No client yet or connection was closed – try to connect (with backoff).
  if (!state.client) {
    if (now - state.lastAttempt < RECONNECT_BACKOFF_MS) {
      throw new Error(
        `Modbus ${group.key}: reconnect backoff (${now - state.lastAttempt}ms < ${RECONNECT_BACKOFF_MS}ms)`
      );
    }

    state.lastAttempt = now;

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
      throw err;
    }
  }

  // We have a client – read discrete inputs.
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
      throw new Error(
        `Invalid response format from readDiscreteInputs for ${group.key}`
      );
    }

    const maxAddr = startAddr + inputs.length - 1;

    dlog(
      `[MODBUS-RESP] ${group.key} len=${inputs.length} inputs[${startAddr}..${maxAddr}] =`,
      inputs
    );

    return inputs;
  } catch (err) {
    console.error(
      `Modbus group ${group.key}: readDiscreteInputs failed, will fall back to default states:`,
      err && err.message ? err.message : err
    );

    try {
      state.client.close();
    } catch (_) {}
    state.client = null;
    state.lastAttempt = Date.now();

    throw err;
  }
}

// --- RDS: WRITE WORKSITE STATE (shared helper) ---
//
// filledBool: true = FILLED, false = EMPTY

async function writeWorksiteState(api, site, filledBool, context) {
  try {
    if (filledBool) {
      await api.setWorkSiteFilled(site.siteId);
    } else {
      await api.setWorkSiteEmpty(site.siteId);
    }

    dlog(
      `[RDS] Worksite ${site.siteId} => ${filledBool ? "FILLED" : "EMPTY"} (${context})`
    );
  } catch (err) {
    console.error(
      `[RDS] Failed to update worksite ${site.siteId} (${context}):`,
      err && err.message ? err.message : err
    );
  }
}

// --- APPLY DEFAULT STATE (used on Modbus error / missing value) ---

async function setSitesDefault(api, sites, context) {
  for (const s of sites) {
    const assumeFilled = defaultToBool(s.default);
    const reason = `set to default (${s.default}) because ${context}`;
    await writeWorksiteState(api, s, assumeFilled, reason);
  }
}

// --- ONE SYNC CYCLE ---

async function syncOnce(api) {
  if (!api.sessionId) {
    try {
      await api.login();
      dlog("[RDS] Initial login succeeded.");
    } catch (err) {
      console.error(
        "[RDS] Initial login failed:",
        err && err.message ? err.message : err
      );
      // Do not abort – APIClient may retry inside its own methods.
    }
  }

  for (const group of GROUPS) {
    const { sites, minOffset } = group;
    const key = group.key;

    let inputs;
    try {
      inputs = await readInputsForGroup(group);
    } catch (err) {
      const errMsg = err && err.message ? err.message : String(err);
      const ctx = `Modbus communication error for ${key}: ${errMsg}`;
      resetDebounceForSites(sites);
      await setSitesDefault(api, sites, ctx);
      continue;
    }

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

      // This process is not the only one that may change RDS,
      // so we always overwrite the worksite state with the current debounced value.
      await writeWorksiteState(
        api,
        s,
        effectiveBool,
        "based on debounced Modbus signal"
      );
    }
  }
}

// --- CLEANUP MODBUS CLIENTS ON EXIT ---

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

// --- MAIN LOOP ---

async function mainLoop() {
  const api = new APIClient(RDS_HOST, RDS_USER, RDS_PASS, RDS_LANG);

  dlog(`Starting synchronization loop (every ${POLL_INTERVAL_MS} ms)`);
  dlog(`Number of Modbus groups: ${GROUPS.length}`);

  while (true) {
    const start = Date.now();

    try {
      await syncOnce(api);
    } catch (err) {
      console.error(
        "Global error in syncOnce:",
        err && err.stack ? err.stack : err
      );
    }

    const elapsed = Date.now() - start;
    const wait = Math.max(POLL_INTERVAL_MS - elapsed, 0);
    if (wait > 0) {
      await sleep(wait);
    }
  }
}

// --- START ---

mainLoop().catch((err) => {
  console.error(
    "Fatal error in mainLoop:",
    err && err.stack ? err.stack : err
  );
  closeAllModbusClients();
});
