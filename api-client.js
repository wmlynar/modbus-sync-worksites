// api-client.js

// Jeśli używasz Node.js w wersji starszej niż 18, odkomentuj poniższą linię oraz zainstaluj node-fetch:
// const fetch = require('node-fetch');

const md5 = require('md5');


function extractCookie(setCookieHeader, name) {
  if (!setCookieHeader) return null;
  // Set-Cookie może zawierać wiele ciastek, rozdzielonych przecinkami
  const parts = setCookieHeader.split(/,(?=[^ ;]+=)/);
  for (const part of parts) {
    const m = part.match(new RegExp(`${name}=([^;]+)`));
    if (m) return m[1];
  }
  return null;
}

class APIClient {

  // Lista statusów uznawanych za aktywne
  static ACTIVE_STATUSES = ["1000", "1002", "1004", "1005", "1006"];
  
  // Słowniki statusów z kluczami językowymi
  static statusDescriptions = {
    en: {
      1000: "Running",
      1001: "Terminated",
      1002: "Suspended",
      1003: "Finished",
      1004: "Abnormally Finished",
      1005: "Restart Exception",
      1006: "Abnormal Interruption"
    },
    pl: {
      1000: "Uruchomiony",
      1001: "Przerwany",
      1002: "Zawieszony",
      1003: "Zakończony",
      1004: "Nieprawidłowo Zakończony",
      1005: "Błąd Restartu",
      1006: "Nieprawidłowe Przerwanie"
    }
  };

  static taskStatusDescriptions = {
    en: {
      1000: "Running",
      1001: "Terminated",
      1002: "Paused",
      1003: "Finished",
      1004: "Exceptional End",
      1005: "Restart exception",
      1006: "Abnormal Interruption",
      1007: "End Manually"
    },
    pl: {
      1000: "Uruchomiony",
      1001: "Zakończony",
      1002: "Pauza",
      1003: "Zakończony",
      1004: "Wyjątkowe zakończenie",
      1005: "Błąd restartu",
      1006: "Nieprawidłowe przerwanie",
      1007: "Zakończony ręcznie"
    }
  };

  static relocStatusDescriptions = {
    en: {
      0: "FAILED",
      1: "SUCCESS",
      2: "RELOCING",
      3: "COMPLETED"
    },
    pl: {
      0: "NIEUDANE",
      1: "SUKCES",
      2: "RELOKOWANIE",
      3: "UKOŃCZONE"
    }
  };

  static robotTaskStatusDescriptions = {
    en: {
      0: "NONE",
      1: "WAITING",
      2: "RUNNING",
      3: "SUSPENDED",
      4: "COMPLETED",
      5: "FAILED",
      6: "CANCELED"
    },
    pl: {
      0: "BRAK",
      1: "OCZEKIWANIE",
      2: "URUCHOMIONY",
      3: "ZAWIESZONY",
      4: "UKOŃCZONY",
      5: "BŁĄD",
      6: "ANULOWANY"
    }
  };

  static dispatchableStatusDescriptions = {
    en: {
      0: "Dispatchable",
      1: "Undispatchable and Online",
      2: "Undispatchable and Offline"
    },
    pl: {
      0: "Dyspozycyjny",
      1: "Niedyspozycyjny Online",
      2: "Niedyspozycyjny Offline"
    }
  };
  
  static levelDescriptions = {
    en: {
      1: "Normal",
      2: "Terminated",
      3: "Error",
      4: "Waiting"
    },
    pl: {
      1: "Normalny",
      2: "Zakończony",
      3: "Błąd",
      4: "Oczekiwanie"
    }
  };
  
  constructor(apiHost, username, password, language = "en") {
    this.apiHost = apiHost;
    this.username = username;
    this.password = password;
    this.sessionId = null;
    this.language = language;
  }

  async login() {
    const url = `${this.apiHost}/admin/login`;
    const requestData = { username: this.username, password: this.encryptPassword(this.password) };
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestData)
    });
    if (!response.ok) {
      throw new Error(`Logowanie nie powiodło się: ${response.status}`);
    }
    const setCookieHeader = response.headers.get("set-cookie");
    const match = setCookieHeader && setCookieHeader.match(/JSESSIONID=([^;]+)/);
    this.sessionId = match ? match[1] : null;
    if (!this.sessionId) {
      throw new Error("Nie udało się pobrać JSESSIONID z ciasteczka.");
    }
    await response.json(); // Ignorujemy treść odpowiedzi – wystarczy ciasteczko
    console.log("Zalogowano, JSESSIONID:", this.sessionId);
  }

  async logout() {
    const url = `${this.apiHost}/admin/logout`;
    const response = await fetch(url, {
      method: "GET",
      headers: { "Cookie": `JSESSIONID=${this.sessionId}` }
    });
    if (!response.ok) {
      throw new Error(`Wylogowanie nie powiodło się: ${response.status}`);
    }
    console.log("Wylogowano poprawnie.");
    this.sessionId = null;
  }


async apiCall(path, options = {}) {
  const url = this.apiHost + path;

  // Upewniamy się, że mamy obiekt nagłówków
  options.headers = options.headers || {};

  // Jeśli mamy sesję, dokładamy ciasteczko JSESSIONID
  if (this.sessionId) {
    options.headers["Cookie"] = `JSESSIONID=${this.sessionId}`;
  }

  // Domyślny Language, jeśli nie został ustawiony ręcznie
  if (!("Language" in options.headers) && !("language" in options.headers)) {
    options.headers["Language"] = this.language || "en";
  }

  let response = await fetch(url, options);

  // UWAGA: TYLKO 401/403 traktujemy jako problem z sesją.
  // 400 już tutaj NIE MA.
  if ([401, 403].includes(response.status)) {
    console.log("Sesja wygasła lub ciasteczko nieprawidłowe, ponowne logowanie...");
    await this.login();
    if (this.sessionId) {
      options.headers["Cookie"] = `JSESSIONID=${this.sessionId}`;
    }
    response = await fetch(url, options);
  }

  // Jeśli dalej jest błąd — zrzucamy status i body do wyjątku
  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch (_) {
      body = "";
    }
    throw new Error(`Błąd wywołania API: ${response.status}, body=${body}`);
  }

  // Sukces — próbujemy sparsować JSON, w razie czego zwracamy surowy tekst
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async apiCall(path, options = {}) {
  // 1. Upewniamy się, że mamy sesję
  if (!this.sessionId) {
    await this.login();
  }

  // 2. Nagłówki
  options.headers = options.headers || {};
  options.headers["Content-Type"] = "application/json";
  options.headers["Cookie"] = `JSESSIONID=${this.sessionId}`;
  options.headers["Language"] = "en"; // albo this.language, jeśli chcesz

  const url = `${this.apiHost}${path}`;

  // 3. Pierwsze wywołanie
  let response = await fetch(url, options);

  // UWAGA: już BEZ 400 – tylko 401/403 jako "wygasła sesja"
  if ([401, 403].includes(response.status)) {
    console.log("Sesja wygasła lub ciasteczko nieprawidłowe, ponowne logowanie...");
    await this.login();
    options.headers["Cookie"] = `JSESSIONID=${this.sessionId}`;
    response = await fetch(url, options);
  }

  // 4. Obsługa błędów
  if (!response.ok) {
    // Specjalne logowanie treści przy 400
    if (response.status === 400) {
      let body = "";
      try {
        body = await response.text();
      } catch (_) {
        body = "";
      }
      console.error("Błąd 400, treść odpowiedzi:", body);
    }
    throw new Error(`Błąd wywołania API: ${response.status}`);
  }

  // 5. Sukces – parsujemy JSON
  return response.json();
}

/*
  async apiCall(path, options = {}) {
    if (!this.sessionId) {
      await this.login();
    }
    options.headers = options.headers || {};
    options.headers["Content-Type"] = "application/json";
    options.headers["Cookie"] = `JSESSIONID=${this.sessionId}`;
    options.headers["Language"] = 'en'; //this.language;
    const url = `${this.apiHost}${path}`;
    let response = await fetch(url, options);
    if ([400, 401, 403].includes(response.status)) {
      console.log("Sesja wygasła lub ciasteczko nieprawidłowe, ponowne logowanie...");
      await this.login();
      options.headers["Cookie"] = `JSESSIONID=${this.sessionId}`;
      response = await fetch(url, options);
    }
    if (!response.ok) {
      throw new Error(`Błąd wywołania API: ${response.status}`);
    }
    return response.json();
  }
*/

/*
async apiCall(path, options = {}) {
  const url = this.apiHost + path;
  options.headers = options.headers || {};

  // jeśli nie mamy sesji – zaloguj
  if (!this.sessionId) {
    await this.login();
  }

  // ZAWSZE dodajemy ciasteczko sesji
  options.headers["Cookie"] = `JSESSIONID=${this.sessionId}`;

  // Language – z dużej litery (tak jak chcesz)
  if (!("Language" in options.headers) && !("language" in options.headers)) {
    options.headers["Language"] = this.language || "en";
  }

  // serviceauth – jak w GUI
  if (
    !("serviceauth" in options.headers) &&
    !("Serviceauth" in options.headers) &&
    !("ServiceAuth" in options.headers)
  ) {
    options.headers["serviceauth"] = "Y";
  }

  // Content-Type dla POST, jeśli nie ustawiono
  const method = (options.method || "GET").toUpperCase();
  if (
    method === "POST" &&
    !("Content-Type" in options.headers) &&
    !("content-type" in options.headers)
  ) {
    options.headers["Content-Type"] = "application/json";
  }

  let response = await fetch(url, options);

  // 400 NIE traktujemy jako problemu z sesją – tylko 401/403
  if ([401, 403].includes(response.status)) {
    console.log("Sesja wygasła lub ciasteczko nieprawidłowe, ponowne logowanie...");
    this.sessionId = null;
    await this.login();
    options.headers["Cookie"] = `JSESSIONID=${this.sessionId}`;
    response = await fetch(url, options);
  }

  if (!response.ok) {
    throw new Error(`Błąd wywołania API: ${response.status}`);
  }

  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
*/

  async getWorkSiteList() {
    const path = "/api/work-sites/sites";
    const requestData = {};
    const responseJson = await this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
    return responseJson.data.map(site => ({
      workSiteId: site.id,
      workSiteName: site.siteId,
      filled: site.filled === 1,
      locked: site.locked === 1,
      lockedBy: site.lockedBy || "",
      content: site.content || "",
      groupName: site.groupName || "",
      tags: site.tags || "",
      displayName: site.siteName || ""
    }));
  }

  async getWorkSiteListRaw() {
    const path = "/api/work-sites/sites";
    const requestData = {};
    return this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
  }

  async setWorkSiteFilled(worksiteName) {
    const path = "/api/work-sites/worksiteFiled";
    const requestData = { workSiteIds: [worksiteName] };
    return this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
  }

  async setWorkSiteEmpty(worksiteName) {
    const path = "/api/work-sites/worksiteUnFiled";
    const requestData = { workSiteIds: [worksiteName] };
    return this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
  }

  async setWorkSiteLocked(worksiteName, lockedBy) {
    const path = "/api/work-sites/lockedSites";
    const requestData = { siteIdList: [worksiteName], lockedBy: lockedBy };
    return this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
  }

  async setWorkSiteUnlocked(worksiteName) {
    const path = "/api/work-sites/unLockedSites";
    const requestData = [worksiteName];
    return this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
  }

  async setWorksiteContent(worksiteName, content) {
    const path = "/api/work-sites/setWorksiteContent";
    const requestData = { workSiteIds: [worksiteName], content: content };
    return this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
  }

  async setWorksiteTags(worksiteName, tags) {
    const path = "/api/work-sites/setWorksiteLabel";
    const requestData = { workSiteIds: [worksiteName], label: tags };
    return this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
  }

  async setWorksiteNumber(worksiteName, number) {
    const path = "/api/work-sites/setWorksiteNumber";
    const requestData = { workSiteIds: [worksiteName], number: number };
    return this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
  }

  async enableWorksite(workSiteId) {
    const path = "/api/work-sites/enableWorksite";
    const requestData = { workSiteIds: [workSiteId] };
    return this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
  }

  async disableWorksite(workSiteId) {
    const path = "/api/work-sites/disableWorksite";
    const requestData = { workSiteIds: [workSiteId] };
    return this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
  }

  async clearWorksiteSyncFailed(workSiteId) {
    const path = "/api/work-sites/clearSyncFailed";
    const requestData = { workSiteIds: [workSiteId] };
    return this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
  }
  
  async updateWorkSite(worksiteId, worksiteName, filled, locked, lockedBy, area, groupName) {
    const workSiteData = {
      id: worksiteId,
      siteId: worksiteName,
      siteName: null,
      working: null,
      locked: locked,
      lockedBy: lockedBy,
      filled: filled,
      disabled: 0,
      syncFailed: 0,
      content: "",
      area: area,
      rowNum: null,
      colNum: null,
      level: null,
      depth: null,
      no: null,
      agvId: null,
      tags: null,
      type: 1,
      groupName: groupName,
      attrList: []
    };
    const path = "/api/work-sites/saveOrUpdateWorkSite";
    return this.apiCall(path, { method: "POST", body: JSON.stringify(workSiteData) });
  }

  async deleteWorksite(workSiteId) {
    const path = "/api/work-sites/deleteWorkSite";
    const requestData = { siteId: workSiteId }; // dokładnie taki format, jak testowałeś ręcznie
    return this.apiCall(path, {
      method: "POST",
      body: JSON.stringify(requestData)
    });
  }

  // Uproszczona metoda getTasks – zakładamy poprawną strukturę odpowiedzi
  async getTasks() {
    const path = "/api/queryTaskRecord";
    const requestData = {
      currentPage: 1,
      pageSize: 1000000,
      queryParam: {
        taskRecordId: null,
        outOrderNo: null,
        agvId: null,
        taskLabel: null,
        startDate: null,
        endDate: null,
        ifParentOrChildOrAll: null,
        ifPeriodTask: 0,
        agvIdList: [],
        stateDescription: null
      }
    };
    const responseJson = await this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
    return responseJson.data.pageList.map(task => ({
      id: task.id,
      def_id: task.def_id,
      agv_id: task.agv_id,
      priority: task.priority,
      status: task.status,
      status_description: APIClient.taskStatusDescriptions[this.language][task.status],
      def_label: task.def_label,
      input_params_summary: Object.fromEntries(
        JSON.parse(task.input_params).map(param => [param.name, param.defaultValue])
      ),
      executor_time: task.executor_time,
      created_on: task.created_on,
      first_executor_time: task.first_executor_time,
      ended_on: task.ended_on
    }));
  }

  // Uproszczona metoda getActiveTasks – status "1005" został usunięty już z activeStatuses
  async getActiveTasks() {
    const activeStatuses = ["1000", "1002", "1004", "1005", "1006"];
    const path = "/api/queryTaskRecord";
    const fetchTasksForStatus = async (status) => {
      const requestData = {
        currentPage: 1,
        pageSize: 1000000,
        queryParam: {
          taskRecordId: null,
          outOrderNo: null,
          agvId: null,
          status: status,
          taskLabel: null,
          startDate: null,
          endDate: null,
          ifParentOrChildOrAll: null,
          ifPeriodTask: 0,
          agvIdList: [],
          stateDescription: null
        }
      };
      const responseJson = await this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
      return responseJson.data.pageList;
    };

    const tasksArrays = await Promise.all(activeStatuses.map(status => fetchTasksForStatus(status)));
    const tasks = tasksArrays.flat();
    return tasks.map(task => ({
      id: task.id,
      def_id: task.def_id,
      agv_id: task.agv_id,
      priority: task.priority,
      status: task.status,
      status_description: APIClient.taskStatusDescriptions[this.language][task.status],
      def_label: task.def_label,
      input_params_summary: Object.fromEntries(
        JSON.parse(task.input_params).map(param => [param.name, param.defaultValue])
      ),
      executor_time: task.executor_time,
      created_on: task.created_on,
      first_executor_time: task.first_executor_time,
      ended_on: task.ended_on
    }));
  }

  // Uproszczona metoda getTasksRaw – zakładamy, że apiCall zwróci poprawny obiekt
  async getTasksRaw() {
    const path = "/api/queryTaskRecord";
    const requestData = {
      currentPage: 1,
      pageSize: 1000000,
      queryParam: {
        taskRecordId: null,
        outOrderNo: null,
        agvId: null,
        taskLabel: null,
        startDate: null,
        endDate: null,
        ifParentOrChildOrAll: null,
        ifPeriodTask: 0,
        agvIdList: [],
        stateDescription: null
      }
    };
    return this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
  }

  async suspendTask(def_id, id) {
    const path = `/api/suspend-task/${def_id}/${id}`;
    return this.apiCall(path, { method: "GET" });
  }

  // Metoda resumeTask zmieniona na GET
  async resumeTask(def_id, id) {
    const path = `/api/start-task/${def_id}/${id}`;
    return this.apiCall(path, { method: "GET" });
  }

  async terminateTask(def_id, id) {
    const path = "/api/stop-all-task";
    const requestData = { releaseSite: 1, stopTaskList: [{ taskId: def_id, taskRecordId: id }] };
    return this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
  }

  async terminateAllTasks() {
    const path = "/api/stop-all-task";
    const requestData = { releaseSite: 1, stopTaskList: [] };
    return this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
  }

  async deleteTask(id) {
    const path = "/api/delete-task";
    return this.apiCall(path, { method: "POST", body: JSON.stringify([id]) });
  }

  async deleteAllTasks() {
    const path = "/api/delete-all-task";
    return this.apiCall(path, { method: "GET" });
  }

  // Zmieniona metoda setTaskPriority przyjmująca (id, priority)
  async setTaskPriority(id, priority) {
    const path = "/api/setTaskPriority";
    const requestData = { priority: priority, taskRecordIds: [id] };
    return this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
  }

  async getTaskCacheData() {
    const path = "/system/getCacheData";
    const requestData = { currentPage: 1, pageSize: 1000000, queryParam: {} };
    const responseJson = await this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
    return responseJson.data;
  }

  async getTaskLogs(taskRecordId, onlyErrors = false) {
    const path = "/api/queryLogsByTaskRecordIdPageAble";
    const requestData = {
      currentPage: 1,
      pageSize: 1000000,
      queryParam: {
        taskRecordId: taskRecordId,
        levels: onlyErrors ? ["2", "3", "4"] : []
      }
    };

    const rawResponse = await this.apiCall(path, { 
      method: "POST", 
      body: JSON.stringify(requestData) 
    });

    return rawResponse.data.pageList.map(log => ({
      level: log.level,
      message: log.message,
      level_description: APIClient.levelDescriptions[this.language][log.level] || "Unknown"
    }));
  }

async getTaskDefForId(id) {
  const path = "/api/queryTaskRecord";
  const requestData = {
    currentPage: 1,
    pageSize: 1,
    queryParam: {
      taskRecordId: id,
      outOrderNo: null,
      agvId: null,
      taskLabel: null,
      startDate: null,
      endDate: null,
      ifParentOrChildOrAll: null,
      ifPeriodTask: 0,
      agvIdList: [],
      stateDescription: null
    }
  };

  const responseJson = await this.apiCall(path, { 
    method: "POST", 
    body: JSON.stringify(requestData) 
  });

  const pageList = responseJson.data?.pageList;
  if (pageList && pageList.length > 0) {
    return pageList[0].def_id;
  } else {
    throw new Error(`Nie znaleziono zadania o id ${id}`);
  }
}

  async getTaskLogsRaw(taskRecordId, onlyErrors = false) {
    const path = "/api/queryLogsByTaskRecordIdPageAble";
    const requestData = {
      currentPage: 1,
      pageSize: 1000000,
      queryParam: {
        taskRecordId: taskRecordId,
        levels: onlyErrors ? ["2", "3", "4"] : []
      }
    };
    return this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
  }

  // Uproszczona metoda getRobotList – zakładamy, że struktura odpowiedzi zawsze jest kompletna
  async getRobotList() {
    const path = "/api/agv-report/core";
    const responseJson = await this.apiCall(path, { method: "GET" });
    const report = responseJson.data.report;
    return report.map(robot => ({
      vehicle: {
        dispatchable: robot.dispatchable,
        is_error: robot.is_error,
        isLoaded: robot.isLoaded,
        vehicle_id: robot.vehicle_id,
        connection_status: robot.connection_status
      },
      current_order: {
        id: robot.current_order.id,
        state: robot.current_order.state,
        externalId: robot.current_order.externalId,
        msg: robot.current_order.msg,
        error: robot.current_order.error,
        complete: robot.current_order.complete
      },
      rbk_report: {
        emergency: robot.rbk_report.emergency,
        blocked: robot.rbk_report.blocked,
        reloc_status: robot.rbk_report.reloc_status,
        reloc_status_description: APIClient.relocStatusDescriptions[this.language][robot.rbk_report.reloc_status],
        battery_level: robot.rbk_report.battery_level,
        confidence: robot.rbk_report.confidence,
        task_status: robot.rbk_report.task_status,
        task_status_description: APIClient.robotTaskStatusDescriptions[this.language][robot.rbk_report.task_status],
        charging: robot.rbk_report.charging,
        soft_emc: robot.rbk_report.soft_emc
      },
      rbk_report_alarms: {
        notices: robot.rbk_report.alarms.notices,
        warnings: robot.rbk_report.alarms.warnings,
        errors: robot.rbk_report.alarms.errors,
        fatals: robot.rbk_report.alarms.fatals
      },
      undispatchable_reason: {
        disconnect: robot.undispatchable_reason.disconnect,
        unconfirmed_reloc: robot.undispatchable_reason.unconfirmed_reloc,
        // Zmienione: zamiast unlock, używamy control_released, true gdy unlock === 1
        control_released: robot.undispatchable_reason.unlock === 1,
        low_battery: robot.undispatchable_reason.low_battery,
        current_map_invalid: robot.undispatchable_reason.current_map_invalid,
        dispatchable_status: robot.undispatchable_reason.dispatchable_status,
        dispatchable_status_description: APIClient.dispatchableStatusDescriptions[this.language][robot.undispatchable_reason.dispatchable_status],
        suspended: robot.undispatchable_reason.suspended
      }
    }));
  }

  async getRobotListRaw() {
    const path = "/api/agv-report/core";
    return this.apiCall(path, { method: "GET" });
  }

  // Funkcje operujące na robotach przyjmujące vehicle_id jako argument
  async robotSetDispatchable(vehicle_id) {
    const path = `/api/controlled-agv/${vehicle_id}/dispatchable/dispatchable`;
    return this.apiCall(path, { method: "POST" });
  }

  async robotSetUndispatchableOnline(vehicle_id) {
    const path = `/api/controlled-agv/${vehicle_id}/dispatchable/undispatchable_unignore`;
    return this.apiCall(path, { method: "POST" });
  }

  async robotSetUndispatchableOffline(vehicle_id) {
    const path = `/api/controlled-agv/${vehicle_id}/dispatchable/undispatchable_ignore`;
    return this.apiCall(path, { method: "POST" });
  }

  async robotSeizeControl(vehicle_id) {
    const path = `/api/controlled-agv/${vehicle_id}/lock`;
    return this.apiCall(path, { method: "POST" });
  }

  async robotReleaseControl(vehicle_id) {
    const path = `/api/controlled-agv/${vehicle_id}/unlock`;
    return this.apiCall(path, { method: "POST" });
  }

  async robotPause(vehicle_id) {
    const path = `/api/controlled-agv/${vehicle_id}/goto-site/pause`;
    return this.apiCall(path, { method: "POST" });
  }

  async robotResume(vehicle_id) {
    const path = `/api/controlled-agv/${vehicle_id}/goto-site/resume`;
    return this.apiCall(path, { method: "POST" });
  }

  async robotConfirmLocation(vehicle_id) {
    const path = `/api/controlled-agv/${vehicle_id}/confirm-re-loc`;
    return this.apiCall(path, { method: "POST" });
  }

  async robotClearAllErrors(vehicle_id) {
    const path = `/api/controlled-agv/${vehicle_id}/clear-robot-all-errors`;
    return this.apiCall(path, { method: "POST" });
  }

  async setForkHeight(vehicle_id, height) {
    const path = `/api/setForkHeight`;
    const requestData = {
      vehicle: vehicle_id,
      height: height
    };
    return this.apiCall(path, {
      method: "POST",
      body: JSON.stringify(requestData)
    });
  }

  async stopFork(vehicle_id) {
    const path = `/api/stopFork`;
    const requestData = {
      vehicle: vehicle_id
    };
    return this.apiCall(path, {
      method: "POST",
      body: JSON.stringify(requestData)
    });
  }

  /**
   * Niskopoziomowe sterowanie ruchem wózka.
   * @param {string} vehicle_id - vehicle_id / uuid robota
   * @param {object} options
   * @param {number} options.vx
   * @param {number} options.vy
   * @param {number} options.w
   * @param {number} options.real_steer
   * @param {number} options.steer
   * @param {number} options.duration
   */
  async controlMotion(vehicle_id, options = {}) {
    if (!vehicle_id || typeof vehicle_id !== "string") {
      throw new Error("controlMotion: 'vehicle_id' musi być niepustym stringiem.");
    }

    const payload = {
      vehicle: vehicle_id,
      vx: options.vx ?? 0.0,
      vy: options.vy ?? 0.0,
      w: options.w ?? 0.0,
      real_steer: options.real_steer ?? 0.0,
      steer: options.steer ?? 0.0,
      duration: options.duration ?? 0.0
    };

    return this.apiCall("/api/controlMotion", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  /**
   * Sterowanie otwartą pętlą: /api/controlled-agv/{id}/open-loop
   * @param {string} vehicle_id - vehicle_id / uuid robota
   * @param {object} options
   * @param {number} options.vx
   * @param {number} options.vy
   * @param {number} options.w
   * @param {number} options.steer
   * @param {number} options.realSteer
   */
  async openLoop(vehicle_id, options = {}) {
    if (!vehicle_id || typeof vehicle_id !== "string") {
      throw new Error("openLoop: 'vehicle_id' musi być niepustym stringiem.");
    }

    const payload = {
      vx: options.vx ?? 0.0,
      vy: options.vy ?? 0.0,
      w: options.w ?? 0.0,
      steer: options.steer ?? 0.0,
      realSteer: options.realSteer ?? 0.0
    };

    const path = `/api/controlled-agv/${vehicle_id}/open-loop`;

    return this.apiCall(path, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  /**
   * Ustawia software emergency (soft EMG) dla robota.
   * @param {string} vehicle_id - ID pojazdu (vehicle_id / uuid)
   * @param {boolean} value - true = enable, false = disable
   */
  async setSoftEmc(vehicle_id, value) {
    if (!vehicle_id || typeof vehicle_id !== "string") {
      throw new Error("setSoftEmc: 'vehicle_id' musi być niepustym stringiem.");
    }

    const path = `/api/agv/setSoftIOEMC`;
    const requestData = {
      vehicle: vehicle_id,
      status: !!value
    };

    return this.apiCall(path, {
      method: "POST",
      body: JSON.stringify(requestData)
    });
  }

  async robotTerminateAndSetUndispatchable(vehicle_id) {
    // Wywołuje RDS:
    // POST {RDS_API_HOST}/api/terminateAndIsExec/{vehicle_id}/true
    const path = `/api/terminateAndIsExec/${vehicle_id}/true`;
    return this.apiCall(path, { method: "POST" });
  }

  /**
   * Terminates a transport order and unlocks sites.
   * @param {string} transportOrderId - ID transport ordera (np. current_order.id z getRobotListRaw)
   */
  async terminateTransportOrder(transportOrderId, setUndispatchable = true) {
    if (!transportOrderId || typeof transportOrderId !== "string") {
      throw new Error("terminateTransportOrder: 'transportOrderId' musi być niepustym stringiem.");
    }

    const path = `/api/terminateAndUnlockSites`;
    const body = {
      agvArray: transportOrderId,
      disable: setUndispatchable,
      taskRecordArray: "",
      isUnlockSite: true
    };

    return this.apiCall(path, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  // Funkcje związane z użytkownikami

  // Funkcja szyfrująca hasło – pozostaje, jeśli będzie potrzebna gdzie indziej
  encryptPassword(password) {
    return md5(password);
  }

  // getUserList nie przyjmuje parametrów – wysyła domyślne zapytanie
  async getUserList() {
    const query = { currentPage: 1, pageSize: 20, queryparam: {} };
    const path = "/admin/user/queryUser";
    return this.apiCall(path, { method: "POST", body: JSON.stringify(query) });
  }

  // addUser przyjmuje (username, password, roles) – rola to tablica nazw (np. ["test1"]). Nie szyfrujemy hasła.
  async addUser(username, password, roles) {
    const user = {
      username: username,
      password: password,
      roles: roles.map(name => ({ name: name })),
      type: 2,
      status: 0
    };
    const path = "/admin/user/addUser";
    return this.apiCall(path, { method: "POST", body: JSON.stringify(user) });
  }

  // updateUser przyjmuje (id, username, password, roles, disabled) – gdy disabled true, status = 1, inaczej 0.
  // Nie szyfrujemy hasła.
  async updateUser(id, username, password, roles, disabled) {
    const user = {
      id: id,
      username: username,
      password: password,
      status: disabled ? 1 : 0,
      type: 2,
      roles: roles.map(name => ({ name: name }))
    };
    const path = "/admin/user/updateUser";
    return this.apiCall(path, { method: "POST", body: JSON.stringify(user) });
  }

  // deleteUser – przyjmuje nazwę użytkownika, wysyła tablicę z nazwą
  async deleteUser(username) {
    const path = "/admin/user/deleteUsers";
    return this.apiCall(path, { method: "POST", body: JSON.stringify([username]) });
  }
  
  

_matchesRequiredParams(task, requiredParams) {
  if (!requiredParams || typeof requiredParams !== "object") return true;

  // Ujednolicenie źródła parametrów do prostego obiektu { key: value }
  const normalize = (src) => {
    if (!src) return {};

    // Jeśli to już obiekt (ale nie tablica) -> użyj wprost
    if (typeof src === "object" && !Array.isArray(src)) {
      return src;
    }

    // Jeśli to tablica [{ name, defaultValue/value, ... }, ...] -> zamień na obiekt
    const arrayToObj = (arr) => {
      const obj = {};
      for (const item of arr) {
        if (item && typeof item === "object") {
          const key = item.name ?? item.label; // czasem bywa 'label'
          if (key !== undefined) {
            const val = item.defaultValue ?? item.value ?? item.val ?? "";
            obj[key] = val;
          }
        }
      }
      return obj;
    };

    // Jeśli to string – może być JSON-em
    if (typeof src === "string") {
      try {
        const parsed = JSON.parse(src);
        if (Array.isArray(parsed)) return arrayToObj(parsed);
        if (parsed && typeof parsed === "object") return parsed;
        return {};
      } catch {
        // nieparsowalny string – nie mamy z niego kluczy
        return {};
      }
    }

    // Jeśli to tablica
    if (Array.isArray(src)) {
      return arrayToObj(src);
    }

    // Inne typy – ignorujemy
    return {};
  };

  const sources = [
    normalize(task.input_params),
    normalize(task.input_params_summary)
  ];

  const containsAll = (src) =>
    Object.entries(requiredParams).every(([k, v]) => {
      if (!(k in src)) return false;
      return String(src[k]) === String(v);
    });

  // Wystarczy, że jeden z możliwych „source” ma wszystkie wymagane pary
  return sources.some(containsAll);
}



  async findTasksByStatusAndParams(statuses = [], requiredParams = {}) {
  
    // ⇩ PUSTA lista = WSZYSTKIE STATUSY → zrobimy jedno zapytanie z status: null
    const normalizedStatuses = (Array.isArray(statuses) && statuses.length > 0)
      ? statuses.map(s => s == null ? null : String(s))
      : [null];
  
    const path = "/api/queryTaskRecord";
    const fetchTasksForStatus = async (status) => {
      const requestData = {
        currentPage: 1,
        pageSize: 1000000,
        queryParam: {
          taskRecordId: null,
          outOrderNo: null,
          agvId: null,
          status: status,
          taskLabel: null,
          startDate: null,
          endDate: null,
          ifParentOrChildOrAll: null,
          ifPeriodTask: 0,
          agvIdList: [],
          stateDescription: null
        }
      };
      const responseJson = await this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
      return responseJson.data.pageList;
    };

    const tasksArrays = await Promise.all(normalizedStatuses.map(status => fetchTasksForStatus(status)));
    const tasks = tasksArrays.flat();
    
    // filtr po wymaganych parametrach
    const filtered = tasks.filter(task => this._matchesRequiredParams(task, requiredParams));
    
    return filtered.map(task => ({
      id: task.id,
      def_id: task.def_id,
      agv_id: task.agv_id,
      priority: task.priority,
      status: task.status,
      status_description: APIClient.taskStatusDescriptions[this.language][task.status],
      def_label: task.def_label,
      input_params_summary: Object.fromEntries(
        JSON.parse(task.input_params).map(param => [param.name, param.defaultValue])
      ),
      executor_time: task.executor_time,
      created_on: task.created_on,
      first_executor_time: task.first_executor_time,
      ended_on: task.ended_on
    }));
  }

/**
 * Tworzy nowe zadanie.
 * @param {string} taskLabel - etykieta zadania (np. "test")
 * @param {object|string} inputParams - obiekt z parametrami lub już zserializowany JSON
 * @returns {Promise<{code:number,msg?:string,data?:any}>}
 */
async createTask(taskLabel, inputParams = {}) {
  if (!taskLabel || typeof taskLabel !== "string" || !taskLabel.trim()) {
    throw new Error("createTask: 'taskLabel' musi być niepustym stringiem.");
  }

  // inputParams w API musi być stringiem JSON
  let inputParamsStr;
  if (typeof inputParams === "string") {
    // opcjonalnie: walidacja JSON
    try { JSON.parse(inputParams); } catch { throw new Error("createTask: 'inputParams' jako string musi być poprawnym JSON-em."); }
    inputParamsStr = inputParams;
  } else if (inputParams && typeof inputParams === "object") {
    inputParamsStr = JSON.stringify(inputParams);
  } else {
    throw new Error("createTask: 'inputParams' musi być obiektem lub stringiem JSON.");
  }

  const path = "/api/set-order";
  const payload = { taskLabel, inputParams: inputParamsStr };

  const res = await this.apiCall(path, {
    method: "POST",
    body: JSON.stringify(payload)
  });

  if (res?.code !== 200) {
    throw new Error(`createTask: błąd API (code=${res?.code}, msg=${res?.msg || "?"})`);
  }
  return res; // { code:200, msg:"SUCCESS", data:null }
}


/**
 * Znajdź zadania o wybranych statusach i z zadanym def_label (taskLabel).
 * Pusta lista statusów oznacza "wszystkie" (status=null w queryParam).
 *
 * @param {Array<string|number>} statuses - np. ["1001","1003"] lub []
 * @param {string} defLabel - dokładnie taki def_label jak w zadaniu
 * @param {number} pageSize - domyślnie 1e6
 * @returns {Promise<Array<Object>>}
 */
async findTasksByStatusesAndLabel(statuses = [], defLabel, pageSize = 1000000) {
  if (!defLabel || typeof defLabel !== "string" || !defLabel.trim()) {
    throw new Error("findTasksByStatusesAndLabel: 'defLabel' musi być niepustym stringiem.");
  }

  const path = "/api/queryTaskRecord";

  // [] => wszystkie statusy -> jedno zapytanie z status:null
  const normalizedStatuses = (Array.isArray(statuses) && statuses.length > 0)
    ? statuses.map(s => (s == null ? null : String(s)))
    : [null];

  const fetchTasksForStatus = async (status) => {
    const requestData = {
      currentPage: 1,
      pageSize,
      queryParam: {
        taskRecordId: null,
        outOrderNo: null,
        agvId: null,
        status: status,         // null => wszystkie
        taskLabel: defLabel,    // filtr po etykiecie
        startDate: null,
        endDate: null,
        ifParentOrChildOrAll: null,
        ifPeriodTask: 0,
        agvIdList: [],
        stateDescription: null
      }
    };
    const res = await this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
    return (res?.data?.pageList) || [];
  };

  // pobierz i spłaszcz
  const tasksArrays = await Promise.all(normalizedStatuses.map(fetchTasksForStatus));
  const tasks = tasksArrays.flat();

  // defensywnie dodatkowy filtr po def_label (na wypadek, gdyby backend zignorował taskLabel)
  const filtered = tasks.filter(t => String(t.def_label) === String(defLabel));

  const mapping =
    (APIClient.taskStatusDescriptions?.[this.language]) ||
    (APIClient.statusDescriptions?.[this.language]) || {};

  return filtered.map(task => ({
    id: task.id,
    def_id: task.def_id,
    agv_id: task.agv_id,
    priority: task.priority,
    status: task.status,
    status_description: mapping[task.status] || "Unknown",
    def_label: task.def_label,
    input_params_summary: this._paramsToObject
      ? this._paramsToObject(task.input_params_summary, task.input_params)
      : (() => {
          // fallback: spróbuj zparsować input_params jako JSON array [{name, defaultValue}, ...]
          try {
            const arr = typeof task.input_params === "string" ? JSON.parse(task.input_params) : (Array.isArray(task.input_params) ? task.input_params : []);
            return Object.fromEntries((arr || []).map(p => [p.name ?? p.label, p.defaultValue ?? p.value ?? ""]));
          } catch { return {}; }
        })(),
    executor_time: task.executor_time,
    created_on: task.created_on,
    first_executor_time: task.first_executor_time,
    ended_on: task.ended_on
  }));
}




/**
 * Zakończ (terminate) wszystkie zadania, które pasują do podanych statusów i parametrów.
 * - korzysta z findTasksByStatusAndParams ([] w statuses => wszystkie statusy)
 * - próbuje zakończyć każde zadanie osobno (kontynuuje mimo błędów)
 *
 * @param {Array<string|number>} statuses
 * @param {Object} requiredParams - np. { param1: "aa", param2: "bb" }
 * @returns {Promise<{requested:number,succeeded:number,failed:number,results:Array}>}
 */
async terminateTasksByStatusAndParams(statuses = [], requiredParams = {}) {
  // 1) Znajdź pasujące zadania
  const tasks = await this.findTasksByStatusAndParams(statuses, requiredParams);
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { requested: 0, succeeded: 0, failed: 0, results: [] };
  }

  // 2) Terminate per task (odporne na błędy)
  const results = [];
  let succeeded = 0;

  for (const t of tasks) {
    try {
      const res = await this.terminateTask(t.def_id, t.id);
      const ok = res?.code === 200;
      if (ok) succeeded++;
      results.push({
        id: t.id,
        def_id: t.def_id,
        ok,
        response: res
      });
    } catch (err) {
      results.push({
        id: t.id,
        def_id: t.def_id,
        ok: false,
        error: String(err?.message || err)
      });
    }
  }

  return {
    requested: tasks.length,
    succeeded,
    failed: tasks.length - succeeded,
    results
  };
}



/**
 * Zakończ (terminate) wszystkie zadania pasujące do statusów i def_label.
 * - korzysta z findTasksByStatusesAndLabel ([] w statuses => wszystkie statusy)
 * - próbuje zakończyć każdy task osobno (kontynuuje mimo błędów)
 *
 * @param {Array<string|number>} statuses
 * @param {string} defLabel
 * @returns {Promise<{requested:number,succeeded:number,failed:number,results:Array}>}
 */
async terminateTasksByStatusesAndLabel(statuses = [], defLabel) {
  if (!defLabel || typeof defLabel !== "string" || !defLabel.trim()) {
    throw new Error("terminateTasksByStatusesAndLabel: 'defLabel' musi być niepustym stringiem.");
  }

  // 1) znajdź pasujące zadania
  const tasks = await this.findTasksByStatusesAndLabel(statuses, defLabel);
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { requested: 0, succeeded: 0, failed: 0, results: [] };
  }

  // 2) terminate per-task
  const results = [];
  let succeeded = 0;

  for (const t of tasks) {
    try {
      const res = await this.terminateTask(t.def_id, t.id);
      const ok = res?.code === 200;
      if (ok) succeeded++;
      results.push({ id: t.id, def_id: t.def_id, ok, response: res });
    } catch (err) {
      results.push({ id: t.id, def_id: t.def_id, ok: false, error: String(err?.message || err) });
    }
  }

  return {
    requested: tasks.length,
    succeeded,
    failed: tasks.length - succeeded,
    results
  };
}


/**
 * Pobierz jeden rekord zadania po taskRecordId (z dowolnym statusem).
 * Zwraca obiekt w tej samej strukturze, której używamy w find*().
 */
async getTaskByRecordId(taskRecordId) {
  if (!taskRecordId) throw new Error("getTaskByRecordId: taskRecordId is required.");
  const path = "/api/queryTaskRecord";
  const requestData = {
    currentPage: 1,
    pageSize: 1,
    queryParam: {
      taskRecordId,
      outOrderNo: null,
      agvId: null,
      status: null,            // null => wszystkie statusy
      taskLabel: null,
      startDate: null,
      endDate: null,
      ifParentOrChildOrAll: null,
      ifPeriodTask: 0,
      agvIdList: [],
      stateDescription: null
    }
  };
  const res = await this.apiCall(path, { method: "POST", body: JSON.stringify(requestData) });
  const t = res?.data?.pageList?.[0];
  if (!t) return null;

  const mapping =
    (APIClient.taskStatusDescriptions?.[this.language]) ||
    (APIClient.statusDescriptions?.[this.language]) || {};

  // spróbuj zamienić input_params na prosty obiekt {key: val}
  let paramsObj = {};
  try {
    const arr = typeof t.input_params === "string"
      ? JSON.parse(t.input_params)
      : (Array.isArray(t.input_params) ? t.input_params : []);
    paramsObj = Object.fromEntries((arr || []).map(p => [p.name ?? p.label, p.defaultValue ?? p.value ?? ""]));
  } catch {}

  return {
    id: t.id,
    def_id: t.def_id,
    agv_id: t.agv_id,
    priority: t.priority,
    status: t.status,
    status_description: mapping[t.status] || "Unknown",
    def_label: t.def_label,
    input_params_summary: paramsObj,
    executor_time: t.executor_time,
    created_on: t.created_on,
    first_executor_time: t.first_executor_time,
    ended_on: t.ended_on
  };
}


  /**
   * Tworzy nowy worksite lub aktualizuje istniejący.
   * Backend rozpoznaje tryb create/update po obecności pola "id".
   *
   * @param {string} worksiteId  - identyfikator (siteId)
   * @param {0|1|boolean} filled - 1/true = zajęty, 0/false = pusty
   * @param {string} groupName   - nazwa grupy
   */
  async createOrUpdateWorkSite(worksiteId, filled = 0, groupName = "") {
    if (!worksiteId || typeof worksiteId !== "string") {
      throw new Error("createOrUpdateWorkSite: 'worksiteId' musi być niepustym stringiem.");
    }

    const payload = {
      siteId: worksiteId,
      groupName: groupName || "",
      type: 0,
      filled: filled ? 1 : 0
    };

    return this.apiCall("/api/work-sites/saveOrUpdateWorkSite", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

}

//module.exports = APIClient;
module.exports = { APIClient };



