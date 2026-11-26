# Deye-Logger ohne lokalen Zugang (Testdaten)

Feldbeleg 25.11.2026, Stick mit Modul-Version DYDA_WiBLE_1.7.2 (WLAN-Modul MXCHIP): was der Stick
**vor jeder Anmeldung** auf Port 80 ausliefert, unverändert übernommen.

| Datei | Anfrage |
|---|---|
| `index.html` | `GET /` (Startseite: Passwort festlegen bzw. Anmeldung; lädt `js/lan_*.js`, `js/aes.js`, `js/rsa.js`, `js/utils.js`) |
| `utils.js` | `GET /js/utils.js` (nennt `PCS_LOCAL_WEB` und `encryptUrl`) |

Keine Seriennummer, keine MAC-Adresse, keine Netzadresse. Gelesen von `deyelogger_test.go`.
