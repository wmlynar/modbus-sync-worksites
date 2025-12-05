# Wymagania produkcyjne – `modbus-sync-worksites`

## Wymagania szczegółowe dla tej usługi

- Konfiguracja:
  - Lista `SITES` z polami: `siteId`, `ip`, `port`, `slaveId`, `offset`, `default` (EMPTY/FILLED).
  - Walidacja konfiguracji przy starcie: unikalne `siteId`, poprawne `offset`, poprawne `default`.
  - Stałe konfiguracyjne na górze pliku: `RDS_HOST`, `RDS_USER`, `RDS_PASS`, `RDS_LANG`, `POLL_INTERVAL_MS`, `MODBUS_REQUEST_TIMEOUT_MS`, `RECONNECT_BACKOFF_MS`, `FILL_DEBOUNCE_MS`.

- Modbus:
  - Grupowanie site’ów po `(ip, port, slaveId)` i jeden klient Modbus na grupę.
  - Wymaganie: **na każdą grupę jest dokładnie jeden klient Modbus i jeden mechanizm backoffu**, a połączenie jest ponownie wykorzystywane między kolejnymi odczytami.
  - Timeout requestu: `client.setTimeout(MODBUS_REQUEST_TIMEOUT_MS)`.
  - Reconnect po błędzie z backoffem `RECONNECT_BACKOFF_MS` (nie spamujemy próbami co `POLL_INTERVAL_MS`).
  - Przy błędzie połączenia / odczytu:
    - zamykamy klienta,
    - logujemy błąd (adres grupy + treść),
    - ustawiamy dla wszystkich site’ów w tej grupie wartości domyślne.

- Domyślny stan + debounce:
  - Każdy `site` ma `default` (EMPTY/FILLED).
  - Stan logiczny:
    - startuje od `default`,
    - wraca natychmiast do `default`, jeśli surowy sygnał Modbus zgadza się z `default`,
    - zmienia się na przeciwny dopiero po stabilnym, przeciwnym sygnale przez `FILL_DEBOUNCE_MS`.
  - **Debounce jest liczony osobno dla każdego worksite (per `siteId`) i nie „miesza się” między site’ami w tej samej grupie.**
  - Przy błędzie Modbus:
    - reset debounce dla site’ów danej grupy,
    - ustawienie `default` w RDS.
  - Przy złej konfiguracji (brak wartości z Modbus – `undefined`):
    - log błędu z informacją o `siteId`, `offset` i indeksie,
    - ustawienie `default` w RDS,
    - reset debounce dla tego site’a.

- Globalne handlery błędów:
  - Wymaganie: usługa musi mieć globalne handlery:
    - `process.on("unhandledRejection", ...)`
    - `process.on("uncaughtException", ...)`
  - Żaden niezłapany wyjątek nie może zabić procesu **bez wpisu w logach** – wszystkie niespodziewane błędy muszą być zalogowane (stacktrace lub treść błędu).

- Obsługa wyłączania (sygnały):
  - Wymaganie: usługa obsługuje sygnały:
    - `SIGINT`,
    - `SIGTERM`.
  - Przy wyłączaniu:
    - loguje informację o zamykaniu,
    - **porządnie zamyka wszystkie połączenia Modbus** (zamyka klientów i sprząta stan),
    - kończy proces kodem 0 (czyste wyjście).

- Logowanie:
  - Flaga `DEBUG_LOG` steruje logami debug (`dlog(...)`); w produkcji `DEBUG_LOG = false`.
  - Błędy Modbus i RDS zawsze przez `console.error` (widoczne w journald), niezależnie od `DEBUG_LOG`.
  - Logi debug:
    - `[MODBUS-REQ]`, `[MODBUS-RESP]`,
    - `[DEBOUNCE] ...`,
    - sukcesy RDS `[RDS] Worksite ... => ...`,
    - informacje o backoffie.
  - Logi produkcyjne nie powinny być zalewane powtarzalnymi komunikatami – np. backoff jest logowany tylko w trybie debug.

- Zachowanie przy braku sterownika Modbus:
  - Pierwszy błąd połączenia / odczytu:
    - log: `[Modbus] Group X: communication error, using default states. Details: ...`,
    - ustawienie `default` w RDS dla wszystkich site’ów grupy.
  - W czasie backoff:
    - brak kolejnych logów błędu (tylko logi debug, jeżeli włączone),
    - brak ponownego nadpisywania RDS (stan domyślny już ustawiony i bezpieczny).

- Integracja z RDS:
  - W każdej iteracji dla każdego `site` po debouncu wysyłamy aktualny stan do RDS (API traktowane jako idempotentne).
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
  - Skrypt instalacyjny `install-modbus-sync-worksites-service.sh`:
    - tworzy unit w `/etc/systemd/system/`,
    - wykonuje `systemctl daemon-reload`,
    - `systemctl enable`,
    - `systemctl start`.

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
  - Commitowane: kod (`*.js`), skrypty bash, `package.json`, `package-lock.json`, `.gitignore`, dokumentacja (`SERVICE_REQUIREMENTS.md`).
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
  - brak parsowania stringów błędów – logika rozróżnia przypadki, nie tekst komunikatu.

- Obsługa błędów:
  - każdy błąd z systemu zewnętrznego (Modbus, HTTP, DB) jest:
    - złapany,
    - zalogowany,
    - obsłużony z jasną strategią: retry / backoff / stan awaryjny (default),
  - żaden niezłapany wyjątek nie może zabić procesu bez loga (`unhandledRejection`, `uncaughtException` muszą być obsłużone).

- Odporność:
  - zdefiniowane „bezpieczne stany domyślne” (default) dla krytycznych elementów,
  - jasne zachowanie przy:
    - braku komunikacji z systemem zewnętrznym,
    - błędnej konfiguracji,
    - restarcie usługi w trakcie pracy.

- Połączenia i stan w pamięci:
  - usługa powinna **ponownie wykorzystywać połączenia** (connection pooling / cache klienta) zamiast otwierać nowe połączenia w każdej iteracji,
  - stan w pamięci powinien być minimalny i jasno określony (np. cache połączeń, cache debounca), bez zbędnych globalnych „śmietników”.

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
  - **w przyszłości** warto dodać prosty healthcheck (np. endpoint HTTP lub okresowe logi podsumowujące):
    - kiedy ostatnio udało się połączyć z systemem zewnętrznym,
    - kiedy ostatnio udało się wykonać operację na backendzie (np. RDS).

- Prostota:
  - brak zbędnych warstw abstrakcji przy prostych usługach,
  - kod możliwy do przeczytania od góry do dołu,
  - brak „sprytnych sztuczek” – zamiast tego proste stany i `if/else`.

- Testy / narzędzia:
  - osobny, prosty skrypt testowy komunikacji z systemem zewnętrznym (Modbus, DB, HTTP),
  - skrypty operatorskie: logi, restart, status, test.

- Repozytorium:
  - kod w gicie,
  - powtarzalny sposób wdrożenia (np. `git pull && npm ci && systemctl restart ...`).
