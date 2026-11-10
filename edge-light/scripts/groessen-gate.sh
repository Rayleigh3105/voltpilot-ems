#!/usr/bin/env bash
# Groessen-Leitplanke fuer ein Edge-Light-Release: verweigert eine Fassung,
# deren Update-Bedarf nicht mehr sicher auf eine Mango (GL-MT300N-V2, 128 MB
# RAM, 16 MB Flash) passt. release.sh ruft sie fuer linux/mipsle auf; der
# Release-Lauf scheitert dann VOR dem Signieren - keine Box bekommt eine
# Fassung angeboten, deren Tausch nur noch auf manchen Geraeten gelingt.
#
#   groessen-gate.sh <programm-mipsle> <programm-mipsle.gz>
#
# ARBEITSSPEICHER: beim Tausch (boot.sh) ist die alte Fassung freigegeben;
# gebraucht werden das entpackte Programm im tmpfs plus Prozess und Entpacken
# (prozess_reserve_kb, 20 000 kB - gemessene VmRSS 16-18 MB plus ~2 MB). Die
# schwaechste beobachtete Mango (Box "Zuhause", 11.2026) hatte beim Tausch
# knapp unter 40 000 kB MemAvailable, auch nach dem Raeumen des Seitencaches;
# das Budget 39 000 kB bleibt 1 000 kB darunter. Die Vorwarnung kommt, sobald
# weniger als 1 MiB Abstand bleibt: beim juengsten Wachstum (~170 KiB je
# Release) sind das etwa sechs Releases, also rund ein halbes Jahr Vorlauf zum
# Verkleinern oder Planen.
#
# FLASH: beim Behalten loescht der Loader die alte Kopie zuerst - es muss also
# EINE gepackte Kopie ins Overlay passen. Gemessen am Geraet (03.10.2026):
# Kopie 4,4 MB plus 4,9 MB frei = 9,3 MB; mindestens 1,5 MB Overlay muessen
# fuer Ereignisliste, Konfiguration und current.json frei bleiben, also
# hoechstens 7 500 000 B fuer die Kopie. Das haelt die gepackte Lieferung
# zugleich deutlich unter der Prozessreserve (20 MB) - nur dann deckt die
# Schwelle "Programm + Prozess" auch die Phasen, in denen die Lieferung im RAM
# daneben liegt (Download, Probe, Nachladen).
set -euo pipefail

PROZESS_RESERVE_KB=20000
RAM_BUDGET_KB=39000
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
ram_abstand_kb=$((RAM_BUDGET_KB - bedarf_kb))
flash_abstand_b=$((FLASH_BUDGET_B - gz_b))

echo "--- Groessen-Leitplanke (Mango):"
printf '    Programm   %10d B -> Update-Bedarf %d kB (Budget %d kB, Abstand %d kB)\n' \
  "$prog_b" "$bedarf_kb" "$RAM_BUDGET_KB" "$ram_abstand_kb"
printf '    Lieferung  %10d B gepackt (Budget %d B, Abstand %d B)\n' \
  "$gz_b" "$FLASH_BUDGET_B" "$flash_abstand_b"

rc=0
if [ "$ram_abstand_kb" -lt 0 ]; then
  echo "FEHLER: das Programm ist zu gross fuer ein Update auf der Mango:" \
    "Bedarf $bedarf_kb kB > Budget $RAM_BUDGET_KB kB (schwaechste bekannte Box beim Tausch)." \
    "Verkleinern oder das Budget NUR mit neuem Beleg vom Geraet anheben." >&2
  rc=1
elif [ "$ram_abstand_kb" -lt "$RAM_WARN_ABSTAND_KB" ]; then
  echo "WARNUNG: nur noch $ram_abstand_kb kB Abstand zum RAM-Budget" \
    "(~$((ram_abstand_kb / 170)) Releases beim juengsten Wachstum) - Verkleinern einplanen." >&2
fi
if [ "$flash_abstand_b" -lt 0 ]; then
  echo "FEHLER: die gepackte Lieferung ($gz_b B) passt nicht mehr sicher in den" \
    "Flash der Mango (Budget $FLASH_BUDGET_B B, >=1,5 MB Overlay muessen frei bleiben)." >&2
  rc=1
elif [ "$flash_abstand_b" -lt "$FLASH_WARN_ABSTAND_B" ]; then
  echo "WARNUNG: nur noch $flash_abstand_b B Abstand zum Flash-Budget - Verkleinern einplanen." >&2
fi
exit "$rc"
