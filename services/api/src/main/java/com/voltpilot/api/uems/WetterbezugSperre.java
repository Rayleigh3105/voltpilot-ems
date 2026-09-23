package com.voltpilot.api.uems;

import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Eine Bezugsgröße, eine Quelle ({@code bezugsdaten.md} § „Wetter-Archiv“; AP-17 Nachlese 1): eine Gradtagzahl mit
 * Zeile in {@code bezugsgroesse_wetterbezug} bezieht ihre Werte von VoltPilot. Eingabe, Berichtigung, Import-Übernahme
 * und die Freigabe ihrer Vorschläge lehnen sie ab wie eine kanalgebundene — 409 {@code wetterbezug_vorhanden}, ganz
 * und nicht nur ab {@code von}. Der Abruf des Archivs ({@link WetterArchivAbruf}) schreibt an diesen Wegen vorbei.
 */
@Component
public class WetterbezugSperre {

    static final String CODE = "wetterbezug_vorhanden";
    static final String SATZ = "Diese Gradtagzahl bezieht ihr Wetter von VoltPilot. Werte werden hier nicht eingegeben "
            + "oder importiert; lösen Sie zuerst den Wetterbezug.";

    private final JdbcTemplate jdbc;

    public WetterbezugSperre(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Wirft 409 {@code wetterbezug_vorhanden}, wenn die Bezugsgröße an das Wetter-Archiv gebunden ist (RLS: Mandant). */
    public void pruefen(UUID bezugsgroesse) {
        if (Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM bezugsgroesse_wetterbezug "
                + "WHERE bezugsgroesse_id = ?)", Boolean.class, bezugsgroesse))) {
            throw new KanalbindungFehler(409, CODE, SATZ);
        }
    }
}
