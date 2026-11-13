package com.voltpilot.api.ueberwachung;

import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.Zuweisung;
import com.voltpilot.api.zugriff.ZugriffRepository;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Die Überwachungs-Dienste urteilen am Standort über sein Kurzzeichen ({@code Ziel.standort("ST-1")}, Kundenbereich
 * mit Kurzzeichen), wie {@code ZugriffRepository.Zeile#alsZuweisung} die Zuweisungen liest. Der Aufrufer einer Route
 * ({@code RechtPruefung.aufrufer()}) trägt seine Standorte dagegen als ID. Ohne Übersetzung fand eine Person mit
 * einer Zuweisung AM STANDORT (Leser, Bearbeiter, Bedienberechtigt) ihren eigenen Standort nicht und bekam beim
 * Anlegen, Ändern oder Stummschalten ihrer eigenen Überwachung 403 "Diese Seite gibt es für Sie nicht"
 * (Befund Kunden-Alarmierung P3); unternehmensweite Rollen traf es nicht.
 */
public final class AufruferStandorte {

    private AufruferStandorte() {
    }

    /** Derselbe Benutzer, jede Standort-ID seiner Zuweisungen als Kurzzeichen; Kurzzeichen bleiben, wie sie sind. */
    public static Benutzer mitKurzzeichen(Benutzer b, List<ZugriffRepository.StandortEintrag> standorte) {
        if (b == null || b.zuweisungen() == null) {
            return b;
        }
        Map<String, String> kurz = standorte.stream().filter(s -> s.kurzzeichen() != null)
                .collect(Collectors.toMap(s -> s.id().toString(), ZugriffRepository.StandortEintrag::kurzzeichen,
                        (a, c) -> a));
        List<Zuweisung> zuweisungen = b.zuweisungen().stream()
                .map(z -> z.standorte() == null ? z : new Zuweisung(z.rolle(),
                        z.standorte().stream().map(s -> kurz.getOrDefault(s, s)).toList(), z.umfang(), z.art(),
                        z.gueltigAb(), z.gueltigBis(), z.beendetAm()))
                .toList();
        return new Benutzer(b.kennung(), b.name(), b.konto(), b.zustand(), zuweisungen);
    }
}
