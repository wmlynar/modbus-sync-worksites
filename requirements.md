# Wymagania produkcyjne – `modbus-sync-worksites`

## Wymagania szczegółowe dla tej usługi

- Konfiguracja:
  - Lista `SITES` z polami: `siteId`, `ip`, `port`, `slaveId`, `offset`, `default` (EMPTY/FILLED).
  - Walidacja konfiguracji przy starcie: unikalne `siteId`, poprawne `offset`, poprawne `default`.
  - Stałe konfiguracyjne na górze pliku: `RDS_HOST`, `RDS_USER`, `RDS_PASS`, `RDS_LANG`, `POLL_INTERVAL_MS`, `MODBUS_REQUEST_TIMEOUT_MS`, `RECONNECT_BACKOFF_MS`, `FILL_DEBOUNCE_MS`.

- Modbus:
  - Grupowanie site’ów po `(ip, port, slaveId)` i jeden klient Modbus na grupę.
  - Timeout requestu: `client.setTimeout(MODBUS_REQUEST_TIMEOUT_MS)`.
  - Reconnect po błędzie z backoffem `RECONNECT_BACKOFF_MS` (nie spamujemy próbami co 500 ms).
  - Przy błędzie połączenia / odczytu:
    - zamykamy klienta,
    - logujemy błąd (adres grupy + treść),
    - ustawiamy dla wszystkich site’ów w tej grupie wartości domyślne.

- Domyślny stan + debounce:
  - Każdy `site` ma `default` (EMPTY/FILLED).
  - Stan logiczny:
    - startuje od `default`,
    - wraca natychmiast do `default`, jeśli sensor zgadza się z `default`,
    - zmienia się na przeciwny dopiero po stabilnym sygnale przeciwnym przez `FILL_DEBOUNCE_MS`.
  - Przy błędzie Modbus:
    - reset debounce dla site’ów danej grupy,
    - ustawienie `default` w RDS.
  - Przy złej konfiguracji (brak wartości z Modbus):
    - log błędu z informacją o `siteId`, `offset`, `idx`,
    - ustawienie `default` w RDS,
    - reset debounce dla tego site’a.

- Logowanie:
  - Flaga `DEBUG_LOG` steruje tylko logami debug (`dlog(...)`).
  - W produkcji `DEBUG_LOG = false`.
  - Błędy Modbus i RDS zawsze przez `console.error` (widoczne w journald).
  - W debug:
    - `[MODBUS-REQ]`, `[MODBUS-RESP]`,
    - `[DEBOUNCE] ...`,
    - sukcesy RDS `[RDS] Worksite ... => ...`,
    - informacje o backoffie.

- Zachowanie przy braku sterownika Modbus:
  - Pierwszy błąd połączenia / odczytu:
    - log: `[Modbus] Group X: communication error, using default states. Details: ...`,
    - ustawienie `default` w RDS dla wszystkich site’ów grupy.
  - W czasie backoff:
    - brak kolejnych logów błędu (tylko debug),
    - brak ponownego nadpisywania RDS (stan już jest bezpieczny).

- Integracja z RDS:
  - W każdej iteracji dla każdego `site` po debouncu wysyłamy aktualny stan do RDS (idempotentne API).
  - Błąd wywołania API:
    - `console.error` z `siteId` i kontekstem.

- Usługa systemd:
  - Unit w `/etc/systemd/system/modbus-sync-worksites.service`:
    - `Type=simple`,
    - `User=admin`, `Group=admin`,
    - `WorkingDirectory=/home/admin/modbus-sync-worksites`,
    - `ExecStart=/usr/bin/nodejs /home/admin/modbus-sync-worksites/modbus-sync-worksites.js`,
    - `Restart=always`, `RestartSec=5`,
    - `After=network-online.target`, `Wants=network-online.target`,
    - `Environment=NODE_ENV=production`.
  - Skrypt instalacyjny `install-modbus-sync-worksites-service.sh` tworzący unit, robiący `daemon-reload`, `enable`, `start`.

- Skrypty operatorskie:
  - `logs-follow.sh` – podgląd logów na żywo (`journalctl -u ... -f`).
  - `logs-last-hour.sh` – logi z ostatniej godziny (`journalctl --since "-1 hour"`).
  - `service-status.sh` – status usługi (`systemctl status ...`).
  - `service-restart.sh` – restart + status.
  - `run-foreground.sh` – uruchomienie usługi w foreground (debug).
  - `modbus-test.sh` – uruchomienie prostego testu Modbus.

- Test Modbus:
  - `modbus-read-test.js`: prosty skrypt Node:
    - łączy się z PLC,
    - co sekundę wywołuje `readDiscreteInputs`,
    - wypisuje surową tablicę `res.data`.

- Repozytorium:
  - Projekt w git + GitHub.
  - Commitowane: kod (`*.js`), skrypty bash, `package.json`, `package-lock.json`, `.gitignore`.
  - `.gitignore` ignoruje `node_modules/`, logi, śmieci edytorów, `.env` itp.

---

## Ogólne wymagania dla usług produkcyjnych

- Konfiguracja:
  - wszystkie istotne parametry (hosty, loginy, hasła, timeouty, interwały) zebrane w jednym miejscu,
  - walidacja konfiguracji przy starcie (duplikaty, zakresy, brakujące pola).

- Logowanie:
  - rozdział: debug vs error,
  - jeden język logów (np. angielski),
  - log błędu zawsze zawiera: co, gdzie, dla kogo (`siteId`, adres, itp.),
  - brak parsowania stringów błędów – logika służy do rozróżniania przypadków, nie tekst komunikatu.

- Obsługa błędów:
  - każdy błąd z systemu zewnętrznego (Modbus, HTTP, DB) jest:
    - złapany,
    - zalogowany,
    - obsłużony z jasną strategią: retry / backoff / stan awaryjny,
  - brak „cichych” wyjątków (globalne handlery logują niespodzianki).

- Odporność:
  - zdefiniowane „bezpieczne stany domyślne” (default) dla krytycznych elementów,
  - jasne zachowanie przy:
    - braku komunikacji,
    - błędnej konfiguracji,
    - restarcie usługi w trakcie pracy.

- Integracja z systemd:
  - `Restart=always` + sensowne `RestartSec`,
  - uruchamianie na nierootowym użytkowniku,
  - `WorkingDirectory` ustawione na katalog projektu,
  - obsługa `SIGINT`/`SIGTERM` (sprzątanie połączeń, czyste wyjście).

- Obserwowalność:
  - możliwość:
    - podglądu logów na żywo,
    - pobrania logów z zakresu czasu,
    - sprawdzenia statusu (`systemctl status`),
  - prosty tryb uruchomienia w foreground (do debugowania bez systemd).

- Prostota:
  - brak zbędnych warstw abstrakcji,
  - kod możliwy do przeczytania od góry do dołu,
  - brak „sprytnych sztuczek” typu parsowanie tekstu błędów – zamiast tego proste stany i if/else.

- Testy / narzędzia:
  - osobny, prosty skrypt testowy komunikacji z systemem zewnętrznym (Modbus, DB, HTTP),
  - skrypty operatorskie: logi, restart, status, test.

- Repozytorium:
  - kod w gicie,
  - powtarzalny sposób wdrożenia (np. `git pull && npm ci && systemctl restart ...`).
