package com.voltpilot.api.repo;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * AP-14 IP-9: die Rohzahlen hinter den UEMS-Betriebsmetriken (§3.5, Schichten „Verarbeitung“ und
 * „Dateneingang je Messkunde“). <b>Nur Lesepfade</b>, und nur Zählungen und Zeitpunkte — kein Name,
 * keine Anschrift, keine Seriennummer verlässt diese Klasse.
 *
 * <p><b>Warum die BYPASSRLS-Rolle, und warum das hier der Punkt ist.</b> Wie
 * {@link DbHealthMetricsRepository} hängt die Sammlung an einem Zeitgeber und hat keinen
 * {@code TenantContext}. Liefe sie über die App-Rolle, gäbe die Mandanten-RLS für JEDE dieser
 * Abfragen null Zeilen zurück — und null Zeilen heißt hier „kein Rückstand, kein Messkunde ohne
 * Werte“: ein stiller Fehlalarm in die beruhigende Richtung. Darum
 * {@code @Qualifier("adminJdbcTemplate")} an {@code voltpilot_admin} (BYPASSRLS, V4); der
 * {@code @Primary}-Pfad der Kunden bleibt unberührt.
 */
@Repository
public class UemsMetricsRepository {

    /** Die Label-Werte {@code liste} — der Vertrag mit den Alarm-Regeln (IP-10). */
    public static final String VIERTELSTUNDE = "viertelstunde";
    /** Siehe {@link #VIERTELSTUNDE}. */
    public static final String TAG = "tag";
    /** Siehe {@link #VIERTELSTUNDE}. */
    public static final String PERIODE = "periode";

    /**
     * Die drei Arbeitslisten in EINER Abfrage. Jede ist ein voller Durchlauf ihrer Tabelle
     * ({@code min(eingetragen_am)} hat keinen eigenen Index, die Entnahme-Indizes stehen auf der
     * fachlichen Reihenfolge) — tragbar, weil die Listen nach oben gedeckelt sind
     * ({@code arbeit-hochwasser}, Vorgabe 200 000) und der Sammler minütlich läuft, nicht je Scrape.
     */
    private static final String ARBEITSLISTEN = """
            SELECT 'viertelstunde' AS liste, count(*) AS offen, min(eingetragen_am) AS aeltester
              FROM messreihe_viertelstunde_arbeit
            UNION ALL
            SELECT 'tag', count(*), min(eingetragen_am) FROM messreihe_tag_arbeit
            UNION ALL
            SELECT 'periode', count(*), min(eingetragen_am) FROM messreihe_periode_arbeit
            """;

    /**
     * Der Dateneingang je MESSKUNDE: ein Kundenbereich mit mindestens einer AKTIVEN Funktion „Messen“
     * — dieselbe Bedingung, die das Produkt stellt ({@code NetzanschlussVorschlagService}: {@code
     * funktion = 'messen' AND zustand = 'aktiv'}).
     *
     * <p><b>Warum nicht {@code device_measurement_sample} selbst.</b> Der Rohwert-Hypertable ist die
     * heißeste Tabelle der Plattform; ein {@code max(received_at)} je Kundenbereich liefe je
     * Sammel-Takt über seine Chunks. {@code messreihe_luecke_stand} trägt dieselbe Frage bereits
     * verdichtet: die Zeilen mit {@code art = 'box'} halten je Box den JÜNGSTEN EINGANG
     * ({@code received_at}) — genau die Größe, die §3.5 nennt, eine Zeile je Box statt eine je
     * Rohwert. Dasselbe tut das Pilot-Blatt T01a (AP-14 IP-1).
     *
     * <p><b>Der Preis, und warum er gedeckt ist:</b> die Zahl entsteht im Lücken-Melder. Steht der,
     * altert sie mit — was die Schicht „Wächter über den Wächter“ mit
     * {@code voltpilot_uems_laeufer_letzter_lauf_age_seconds{laeufer="luecken"}} genau dafür sieht.
     *
     * <p>Ein Messkunde ohne jede Box-Zeile kommt MIT {@code null} zurück: „nie ein Messwert“ ist
     * etwas anderes als „keine Frage gestellt“, und der Sammler macht daraus keinen Alterswert.
     */
    private static final String MESSKUNDEN = """
            SELECT m.tenant_id AS tenant_id, max(l.zuletzt) AS zuletzt
              FROM (SELECT DISTINCT tenant_id FROM funktion
                     WHERE funktion = 'messen' AND zustand = 'aktiv') m
              LEFT JOIN messreihe_luecke_stand l
                     ON l.tenant_id = m.tenant_id AND l.art = 'box'
             GROUP BY m.tenant_id
             ORDER BY m.tenant_id
            """;

    /** Eine Arbeitsliste: wie viele Einträge offen sind und wie alt der älteste ist. */
    public record ArbeitslisteStand(String liste, long offen, Instant aeltester) {}

    /** Ein Messkunde: seine INTERNE Kennung und der jüngste Eingang; {@code zuletzt} null = nie. */
    public record MesskundeEingang(UUID tenantId, Instant zuletzt) {}

    private final JdbcTemplate admin;

    public UemsMetricsRepository(@Qualifier("adminJdbcTemplate") JdbcTemplate admin) {
        this.admin = admin;
    }

    /** Die drei Arbeitslisten, immer alle drei — eine leere Liste ist {@code offen = 0}, nicht nichts. */
    public List<ArbeitslisteStand> arbeitslisten() {
        List<ArbeitslisteStand> stand = new ArrayList<>(3);
        admin.query(ARBEITSLISTEN, rs -> {
            Timestamp aeltester = rs.getTimestamp("aeltester");
            stand.add(new ArbeitslisteStand(rs.getString("liste"), rs.getLong("offen"),
                    aeltester == null ? null : aeltester.toInstant()));
        });
        return stand;
    }

    /** Je Kundenbereich mit aktiver Funktion „Messen“ der jüngste Eingang; nie gemessen = {@code null}. */
    public List<MesskundeEingang> messkundenEingaenge() {
        List<MesskundeEingang> eingaenge = new ArrayList<>();
        admin.query(MESSKUNDEN, rs -> {
            Timestamp zuletzt = rs.getTimestamp("zuletzt");
            eingaenge.add(new MesskundeEingang(rs.getObject("tenant_id", UUID.class),
                    zuletzt == null ? null : zuletzt.toInstant()));
        });
        return eingaenge;
    }
}
