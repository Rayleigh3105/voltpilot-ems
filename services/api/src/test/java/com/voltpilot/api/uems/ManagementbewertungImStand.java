package com.voltpilot.api.uems;

import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Testhilfe (AP-19, MG6): eine freigegebene Managementbewertung {@code kennung} mit den Beschlüssen 1 bis {@code bis},
 * direkt als Zeilen gesetzt — für Tests, die eine Folge mit Beschluss schreiben, ohne die Managementbewertung selbst zu
 * prüfen. Den ganzen Weg über die Routen geht {@code ManagementbewertungVorlageApiTest}.
 */
final class ManagementbewertungImStand {

    private ManagementbewertungImStand() {
    }

    static UUID anlegen(JdbcTemplate root, UUID tenant, UUID unternehmen, UUID entschiedenVon, String kennung,
            int bis) {
        UUID bericht = root.queryForObject("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, "
                + "geltung_art, unternehmen_id, zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_name) "
                + "VALUES (?, ?, 'managementbewertung', 1, 'unternehmen', ?, 'jahr', '2028', 'Europe/Berlin', "
                + "'Ines Kaltenbach') RETURNING id", UUID.class, tenant, kennung, unternehmen);
        String abzug = "{\"bericht\":\"" + kennung + "\",\"zeitraum\":\"2028\"}";
        root.update("INSERT INTO bericht_stand (tenant_id, bericht_id, nr, abzug, pruefsumme, datenstand, freigegeben_am, "
                + "freigeber_sub, freigeber_name, freigeber_rolle, darstellung, regelwerk, vorlage_fassung) VALUES "
                + "(?, ?, 1, ?, ?, '2029-01-20T14:00:00Z', '2029-01-20T14:05:00Z', 'kc-ines-kaltenbach', "
                + "'Ines Kaltenbach', 'energiemanager', '{}'::jsonb, '{}'::jsonb, 1)", tenant, bericht, abzug,
                BerichtRegeln.pruefsumme(abzug));
        for (int nr = 1; nr <= bis; nr++) {
            root.update("INSERT INTO managementbewertung_beschluss (tenant_id, bericht_id, nr, art, wortlaut, "
                    + "entschieden_von, actor_sub, actor_name, actor_art) VALUES (?, ?, ?, 'aufgabe', ?, ?, "
                    + "'kc-ines-kaltenbach', 'Ines Kaltenbach', 'kunde')", tenant, bericht, nr, "Beschluss B" + nr,
                    entschiedenVon);
        }
        return bericht;
    }
}
