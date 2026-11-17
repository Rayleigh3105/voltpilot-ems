#!/usr/bin/env bash
# Groessen-Leitplanke fuer ein Edge-Light-Release: verweigert eine Fassung,
# deren Update-Bedarf nicht mehr sicher auf eine Mango (GL-MT300N-V2, 128 MB
# RAM, 16 MB Flash) passt, und warnt, wenn Boxen mit einem aelteren Loader sie
# nicht tauschen koennten. release.sh ruft sie fuer linux/mipsle auf; ein
# FEHLER laesst den Release-Lauf VOR dem Signieren scheitern - keine Box
# bekommt eine Fassung angeboten, deren Tausch nur noch auf manchen Geraeten
# gelingt.
#
#   groessen-gate.sh <programm-mipsle> <programm-mipsle.gz>
#
# ARBEITSSPEICHER: Den Tausch auf diese Fassung macht der Loader, der schon auf
# der Box liegt, nicht der, den diese Fassung mitbringt (agent/loader_pflege.go:
# ein neuer Loader kommt erst mit der bestaetigten Fassung). Er verlangt nach
# dem Raeumen des Seitencaches MemAvailable >= Groesse des entpackten
# Programms + prozess_reserve_kb:
#   - Loader Stand 2: 12 000 kB, privater Speicher des Prozesses plus
#     Entpacken (boot.sh);
#   - Loader Stand 1: 20 000 kB, aus der VmRSS samt Seiten der Programmdatei.
#     Ihn tragen Boxen, bis sie einmal auf eine Fassung mit Stand 2 getauscht
#     haben. Die UCI-Option prozess_reserve_kb uebersteuert beide.
# Das Budget ist die schwaechste gemessene Mango im Tauschweg: ASP
# (edge-tgjn9gd) am 17.11.2026 mit 36 744 kB nach dem Raeumen. Im tmpfs lagen
# dabei die Lieferung (kandidat.gz, 5 430 kB) und der volle Messwert-Puffer
# (48 h, 16 848 kB). Mit dem frueheren Budget 39 000 kB ("Zuhause") kamen
# 11.13 und 11.15 ohne Warnung durch, und ASP nahm 11.15 zurueck
# (36 744 kB < 37 024 kB).
#   FEHLER   auch Loader Stand 2 tauscht nicht auf der schwaechsten Mango.
#   WARNUNG  Loader Stand 1 tauscht dort nicht (die Box nimmt zurueck, die
#            bestaetigte Fassung laeuft weiter), oder fuer Stand 2 bleibt
#            weniger als 1 MiB Abstand (11.12 -> 11.15: +896 KiB in zwei
#            Releases).
# Das Budget haengt am Inhalt des tmpfs beim Tausch, vor allem am Puffer des
# laufenden Programms. Fassungen nach 11.15 loeschen gesendete Segmente; der
# Tausch WEG von einer solchen Fassung sieht nur noch den ungesendeten Rest.
# Erst wenn das an ASP gemessen ist (Loader-Meldung beim Tausch: "genug
# freier Speicher (<x> kB >= ...)" oder "Seitencache geraeumt: ... -> <x>
# kB"), das Budget mit diesem Beleg anheben.
#
# FLASH: beim Behalten loescht der Loader die alte Kopie zuerst - es muss also
# EINE gepackte Kopie ins Overlay passen. Gemessen am Geraet (03.10.2026):
# Kopie 4,4 MB plus 4,9 MB frei = 9,3 MB; mindestens 1,5 MB Overlay muessen
# fuer Ereignisliste, Konfiguration und current.json frei bleiben, also
# hoechstens 7 500 000 B fuer die Kopie. Das haelt die gepackte Lieferung
# zugleich unter der Prozessreserve (12 000 kB) - nur dann deckt die Schwelle
# "Programm + Prozess" auch das Nachladen, bei dem die Lieferung erst nach der
# Messung in den RAM kommt (beim Tausch liegt sie schon dort und ist
# abgezogen).
set -euo pipefail

PROZESS_RESERVE_KB=12000
PROZESS_RESERVE_STAND1_KB=20000
RAM_BUDGET_KB=36744
RAM_WARN_ABSTAND_KB=1024
FLASH_BUDGET_B=7500000
FLASH_WARN_ABSTAND_B=600000

PROG="${1:-}"
GZ="${2:-}"
[ -r "$PROG" ] && [ -r "$GZ" ] || {
  echo "FEHLER: Aufruf: groessen-gate.sh <programm-mipsle> <programm-mipsle.gz>" >&2
  exit 2
}

prog_b=$(($(wc -c <"$PROG")))
gz_b=$(($(wc -c <"$GZ")))
bedarf_kb=$((prog_b / 1024 + PROZESS_RESERVE_KB))
bedarf_stand1_kb=$((prog_b / 1024 + PROZESS_RESERVE_STAND1_KB))
ram_abstand_kb=$((RAM_BUDGET_KB - bedarf_kb))
ram_abstand_stand1_kb=$((RAM_BUDGET_KB - bedarf_stand1_kb))
flash_abstand_b=$((FLASH_BUDGET_B - gz_b))

echo "--- Groessen-Leitplanke (Mango):"
printf '    Programm   %10d B -> Update-Bedarf %d kB (Budget %d kB, Abstand %d kB)\n' \
  "$prog_b" "$bedarf_kb" "$RAM_BUDGET_KB" "$ram_abstand_kb"
printf '                             mit Loader Stand 1 %d kB (Abstand %d kB)\n' \
  "$bedarf_stand1_kb" "$ram_abstand_stand1_kb"
printf '    Lieferung  %10d B gepackt (Budget %d B, Abstand %d B)\n' \
  "$gz_b" "$FLASH_BUDGET_B" "$flash_abstand_b"

rc=0
if [ "$ram_abstand_kb" -lt 0 ]; then
  echo "FEHLER: das Programm ist zu gross fuer ein Update auf der Mango:" \
    "Bedarf $bedarf_kb kB > Budget $RAM_BUDGET_KB kB (schwaechste gemessene Box beim Tausch)." \
    "Verkleinern oder das Budget NUR mit neuem Beleg vom Geraet anheben." >&2
  rc=1
else
  if [ "$ram_abstand_kb" -lt "$RAM_WARN_ABSTAND_KB" ]; then
    echo "WARNUNG: nur noch $ram_abstand_kb kB Abstand zum RAM-Budget - Verkleinern einplanen." >&2
  fi
  if [ "$ram_abstand_stand1_kb" -lt 0 ]; then
    echo "WARNUNG: Boxen mit Loader Stand 1 tauschen diese Fassung auf der schwaechsten Mango nicht:" \
      "Bedarf $bedarf_stand1_kb kB > Budget $RAM_BUDGET_KB kB. Sie nehmen zurueck und laufen auf der" \
      "bestaetigten Fassung weiter; Uebergang je Box ueber uci prozess_reserve_kb." >&2
  fi
fi
if [ "$flash_abstand_b" -lt 0 ]; then
  echo "FEHLER: die gepackte Lieferung ($gz_b B) passt nicht mehr sicher in den" \
    "Flash der Mango (Budget $FLASH_BUDGET_B B, >=1,5 MB Overlay muessen frei bleiben)." >&2
  rc=1
elif [ "$flash_abstand_b" -lt "$FLASH_WARN_ABSTAND_B" ]; then
  echo "WARNUNG: nur noch $flash_abstand_b B Abstand zum Flash-Budget - Verkleinern einplanen." >&2
fi
exit "$rc"
