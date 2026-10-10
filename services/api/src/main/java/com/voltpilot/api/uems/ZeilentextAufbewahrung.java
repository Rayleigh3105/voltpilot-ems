package com.voltpilot.api.uems;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * E14 — der Zeilentext eines Imports bleibt ZWEI JAHRE (UEMS AP-09 IP-12). Danach entfernt dieser Lauf
 * ihn: {@code text} wird {@code NULL}, {@code text_entfernt_am} sagt wann. Urteil, Befunde, der fachliche
 * Schlüssel und der Zeilen-Fingerabdruck bleiben — ein späterer Import erkennt seine Dublette weiter.
 *
 * <p>Die Frist steht an EINER Stelle, {@code bezugsdaten_zeilentext_frist()}; der Append-only-Trigger der
 * Zeilen fragt dieselbe Funktion und lässt den Übergang erst nach ihr durch. Der Lauf arbeitet über alle
 * Kundenbereiche und braucht darum die Verwaltungsrolle; sie hat auf der Tabelle nur das Spaltenrecht für
 * diese beiden Spalten. Stapel zu {@link #STAPEL} Zeilen, damit eine große Altlast keine lange Sperre hält.
 */
@Component
public class ZeilentextAufbewahrung {

    public static final int STAPEL = 5_000;

    private final JdbcTemplate admin;

    public ZeilentextAufbewahrung(@Qualifier("adminJdbcTemplate") JdbcTemplate admin) {
        this.admin = admin;
    }

    /** Entfernt jeden Zeilentext, der älter als die Frist ist; gibt die Zahl der entfernten zurück. */
    public int lauf() {
        int gesamt = 0;
        int stapel;
        do {
            stapel = admin.update("UPDATE bezugsdaten_import_zeile SET text = NULL, text_entfernt_am = now() "
                    + "WHERE ctid IN (SELECT ctid FROM bezugsdaten_import_zeile WHERE text IS NOT NULL "
                    + "AND created_at <= now() - bezugsdaten_zeilentext_frist() LIMIT " + STAPEL + ")");
            gesamt += stapel;
        } while (stapel == STAPEL);
        return gesamt;
    }
}
