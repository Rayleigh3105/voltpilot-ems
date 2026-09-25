package com.voltpilot.api.uems;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * UEMS AP-19 IP-23 (WV1, WV2, MG7): die Wiedervorlage-Quelle „Managementbewertung“ — die nächste Managementbewertung
 * ist fällig am Tag der letzten Sitzung einer freigegebenen Managementbewertung + Rhythmus (Einstellung
 * {@code managementbewertung_rhythmus_monate}, Startwert 12), beim Abruf über die Operation {@code ueberpruefung} des
 * Vertrags; nie gespeichert. Ohne freigegebene Managementbewertung keine Frist und keine Zeile (kein erfundener Beginn).
 * Kennzeichen ist die Managementbewertung, an deren Sitzung die Frist hängt; verantwortlich, wer am Abruf die laufende
 * Aufgabe „Managementbewertung vorbereiten“ hat. Dieselbe Rechnung trägt die Wiedervorlage als Feld
 * {@code naechste_managementbewertung} auch außerhalb ihres Vorschau-Fensters (Folge IP-24, {@link #naechste}). Ohne Sprung (WV3): die Portal-Seite der Managementbewertung gibt es noch nicht.
 */
@Component
@Order(40)
public class ManagementbewertungWiedervorlage implements WiedervorlageQuelle {

    private final JdbcTemplate jdbc;

    public ManagementbewertungWiedervorlage(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Die nächste Managementbewertung (MG7) — woraus sie folgt (Kennzeichen und Tag der letzten Sitzung, Rhythmus) und
     * wann sie fällig ist, auch außerhalb des Vorschau-Fensters der Wiedervorlage.
     */
    public record Naechste(String kennzeichen, LocalDate sitzungAm, int rhythmusMonate, LocalDate faelligAm,
            String verantwortlich) {}

    @Override
    public List<Frist> fristen(LocalDate abruf) {
        return naechste(abruf).map(n -> List.of(new Frist("managementbewertung", n.kennzeichen(),
                "Nächste Managementbewertung", n.faelligAm(), n.verantwortlich(), null, null))).orElse(List.of());
    }

    /** Die EINE Rechnung von MG7: die Frist der Wiedervorlage und das Feld {@code naechste_managementbewertung}. */
    public Optional<Naechste> naechste(LocalDate abruf) {
        List<Map<String, Object>> sitzungen = jdbc.queryForList("""
                SELECT b.kennung, s.tag FROM bericht b
                  JOIN managementbewertung_sitzung s ON s.tenant_id = b.tenant_id AND s.bericht_id = b.id
                 WHERE b.vorlage = 'managementbewertung' AND b.archiviert_am IS NULL AND s.tag <= ?
                   AND EXISTS (SELECT 1 FROM bericht_stand st WHERE st.tenant_id = b.tenant_id AND st.bericht_id = b.id)
                 ORDER BY s.tag DESC, b.kennung DESC
                """, abruf);
        if (sitzungen.isEmpty()) return Optional.empty();
        int monate = jdbc.queryForList("SELECT managementbewertung_rhythmus_monate FROM energiemanagement_einstellung",
                Integer.class).stream().findFirst()
                .orElse(EnergiemanagementRegeln.STARTWERTE.managementbewertung_rhythmus_monate());
        List<String> tage = sitzungen.stream().map(z -> z.get("tag").toString()).toList();
        Map<String, Object> frist = EnergiemanagementRegeln.ueberpruefung(new EnergiemanagementRegeln.UeberpruefungEingang(
                "managementbewertung", null, monate, null, null, tage, null, null, null, null, abruf.toString()));
        if (frist.get("faellig_am") == null) return Optional.empty();
        String verantwortlich = jdbc.queryForList("""
                SELECT p.name FROM energiemanagement_aufgabe a
                  JOIN energiemanagement_person p ON p.tenant_id = a.tenant_id AND p.id = a.person_id
                 WHERE a.aufgabe = 'managementbewertung' AND a.gilt_ab <= ? AND (a.gilt_bis IS NULL OR a.gilt_bis >= ?)
                 ORDER BY a.gilt_ab DESC, p.name LIMIT 1
                """, String.class, abruf, abruf).stream().findFirst().orElse(null);
        Map<String, Object> letzte = sitzungen.get(0);
        return Optional.of(new Naechste((String) letzte.get("kennung"), LocalDate.parse(letzte.get("tag").toString()),
                monate, LocalDate.parse(frist.get("faellig_am").toString()), verantwortlich));
    }
}
