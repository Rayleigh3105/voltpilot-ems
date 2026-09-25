package com.voltpilot.api.uems;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Der Seed-Weg der Prüfumgebung Ahrenberg (UEMS AP-20 IP-13, E5, PD1): auf den Seed 1.4
 * ({@code infra/local/seed/ahrenberg.sql}) die Welt der Referenzdatei 1.10 — {@link AhrenbergWelt} im Ziel
 * {@link AhrenbergWelt.Ziel#SEED}, dieselben Schritte wie die Abnahme {@code UemsEnergiemanagementAbnahmeTest}.
 * Genutzt von {@link PruefumgebungAhrenbergTest} (Testcontainers) und {@link PruefumgebungAhrenbergAufbau} (gegen die
 * Datenbank des lokalen Stapels).
 */
final class PruefumgebungAhrenberg {
    /** Der Augenblick, an dem die Bühne steht: der letzte Lese-Tag der Abnahme. */
    static final String BUEHNE = "2029-04-30T08:00:00Z";

    private PruefumgebungAhrenberg() {
    }

    /**
     * Baut die Welt, wenn sie noch nicht steht. Idempotent: steht schon die Wirksamkeit von F-2029-0001 (der letzte
     * Schritt der Welt), geschieht nichts; ein halber Aufbau bricht ab, statt die Welt doppelt zu schreiben.
     *
     * @param buehne stellt beim Aufbau jede Uhr der Welt, auch die der Zuweisungen (die Zuweisungen des Seeds beginnen
     *               erst am 01.10.2026), und danach die Bühne
     * @return {@code true}, wenn die Welt jetzt gebaut wurde
     */
    static boolean aufbauen(MockMvc mvc, JdbcTemplate root, PruefumgebungUhr buehne) throws Exception {
        if (zahl(root, "SELECT count(*) FROM unternehmen WHERE tenant_id = ?") == 0) {
            throw new IllegalStateException("Der Ahrenberg-Seed fehlt — erst infra/local/seed/ahrenberg.sql einspielen "
                    + "(Dienst demo-seed).");
        }
        if (zahl(root, "SELECT count(*) FROM feststellung_wirksamkeit WHERE tenant_id = ?") > 0) {
            return false;
        }
        if (zahl(root, "SELECT count(*) FROM benutzer WHERE tenant_id = ? AND sub = '"
                + AhrenbergWelt.SEED_SUBJECTS.get("RF") + "'") > 0) {
            // Robert Falk ist der erste Schritt der Welt, die Wirksamkeit der letzte.
            throw new IllegalStateException("Die Welt steht nur halb (ein früherer Aufbau brach ab) — die Prüfumgebung "
                    + "abräumen und neu aufbauen.");
        }
        try {
            new AhrenbergWelt(mvc, root, buehne::stellen, AhrenbergWelt.Ziel.SEED).aufbauen();
        } finally {
            buehne.stellen();
        }
        return true;
    }

    private static int zahl(JdbcTemplate root, String sql) {
        Integer n = root.queryForObject(sql, Integer.class, AhrenbergWelt.AHRENBERG);
        return n == null ? 0 : n;
    }
}
