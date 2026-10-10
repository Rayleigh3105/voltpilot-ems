package com.voltpilot.api.uems;

import java.util.Map;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * AP-19: der Beschluss {@code BR-…/Bn} einer Managementbewertung, den eine Folge nennt — eine Stelle für die Maßnahme,
 * die Feststellung und die Folgen aus dem Energiemanagement (Aufgabe zuordnen, Dokument-Fassung, „geprüft, bleibt“).
 * Gelesen unter RLS: nur Managementbewertungen des eigenen Kundenbereichs zählen.
 */
final class ManagementbewertungBeschluss {

    private ManagementbewertungBeschluss() {
    }

    /** Leer ohne Beschluss n dieser Managementbewertung, sonst ob die Managementbewertung einen Stand hat. */
    static Optional<Boolean> imStand(JdbcTemplate jdbc, String kennung) {
        int b = kennung.lastIndexOf("/B");
        return jdbc.queryForList("SELECT EXISTS (SELECT 1 FROM bericht_stand s WHERE s.tenant_id = r.tenant_id "
                + "AND s.bericht_id = r.id) FROM bericht r JOIN managementbewertung_beschluss m ON m.tenant_id = r.tenant_id "
                + "AND m.bericht_id = r.id WHERE r.kennung = ? AND r.vorlage = 'managementbewertung' AND m.nr = ?",
                Boolean.class, kennung.substring(0, b), Integer.parseInt(kennung.substring(b + 2))).stream().findFirst();
    }

    /**
     * MG6: eine Folge im Energiemanagement nennt einen Beschluss, den es gibt, aus einer freigegebenen
     * Managementbewertung — sonst 422 {@code beschluss_unbekannt} bzw. {@code managementbewertung_nicht_freigegeben}.
     * Ein Tippfehler wäre sonst still keine Folge. {@code null} (kein Beschluss genannt) bleibt erlaubt.
     */
    static void pruefen(JdbcTemplate jdbc, String kennung) {
        if (kennung == null) {
            return;
        }
        boolean stand = imStand(jdbc, kennung).orElseThrow(() -> EnergiemanagementAbgelehnt.fachlich(
                "beschluss_unbekannt", "Den Beschluss " + kennung + " gibt es in Ihrem Kundenbereich nicht.",
                Map.of("feld", "beschluss_kennung")));
        if (!stand) {
            throw EnergiemanagementAbgelehnt.fachlich("managementbewertung_nicht_freigegeben", "Die "
                    + "Managementbewertung " + kennung.substring(0, kennung.lastIndexOf("/B")) + " ist noch nicht "
                    + "freigegeben — eine Folge nennt einen Beschluss im Stand.", Map.of("feld", "beschluss_kennung"));
        }
    }
}
