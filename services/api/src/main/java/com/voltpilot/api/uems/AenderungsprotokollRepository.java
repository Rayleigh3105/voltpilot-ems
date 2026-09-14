package com.voltpilot.api.uems;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Das LESEMODELL der drei Änderungsprotokolle (UEMS AP-04 IP-21) — es schreibt nichts und
 * ändert keine Tabelle: {@code messstelle_aenderung} (V20260911140000),
 * {@code ort_aenderung} (V20260911100000) und {@code data_source_aenderung}
 * (V20260911180000) werden in EINER Abfrage zusammengeführt.
 *
 * <p><b>Die zwei Zeitachsen.</b> Jeder Eintrag hat zwei Zeitpunkte, und sie sind verschieden:
 * <ul>
 *   <li>{@code gilt_ab} — WANN die Änderung gilt (die WIRKUNG). Der Zählerwechsel von MS-06
 *       gilt am 18.11.2026 um 10:40.</li>
 *   <li>{@code created_at} — WANN sie eingetragen wurde (der EINTRAG). Derselbe Wechsel wurde
 *       um 11:05 eingetragen, also 25 min rückwirkend.</li>
 * </ul>
 * Ein Zeitraum-Filter auf der falschen Achse verliert genau die Einträge, um die es geht.
 * {@link Achse} ist deshalb ein AUSDRÜCKLICHER Parameter mit der Vorgabe {@link Achse#WIRKUNG}
 * (die Abnahme von IP-21: „der rückwirkende Wechsel erscheint im Zeitraum des BETROFFENEN
 * Zeitpunkts"), nie eine stille Annahme.
 *
 * <p><b>Die Überbrückung uneinheitlicher Spalten (Nacharbeit AP-03 IP-7).</b> Die drei
 * Journale sind heute nicht zeichengleich; dieses Lesemodell überbrückt das an GENAU DREI
 * Stellen, ohne eine Tabelle umzubenennen:
 * <ol>
 *   <li><b>Urheber:</b> {@code messstelle_aenderung} und {@code data_source_aenderung} tragen
 *       {@code actor_sub/name/rolle/art}; {@code ort_aenderung} kennt nur
 *       {@code akteur_sub}/{@code akteur_name}. Die Rolle eines Orts-Eintrags ist deshalb
 *       {@code NULL} = „nicht festgehalten" — nie geraten. Seine ART ist
 *       {@code voltpilot}, wenn der Name das Wort trägt, das {@link OrtProtokoll#akteurName}
 *       dafür schreibt, sonst ebenfalls {@code NULL}.</li>
 *   <li><b>„gilt ab":</b> in {@code ort_aenderung} ein TAG, in den beiden anderen ein
 *       Zeitpunkt. Der Tag wird auf seinen Beginn in {@link MessstelleService#ZEITZONE}
 *       gehoben — Europe/Berlin, Vienna und Zurich haben denselben Versatz, die Umrechnung
 *       ist also eindeutig.</li>
 *   <li><b>„rückwirkend":</b> {@code messstelle_aenderung} und {@code ort_aenderung} haben die
 *       Spalte (ihr Schreiber hat sie gerechnet und sie gilt); {@code data_source_aenderung}
 *       hat sie NICHT — dort wird sie aus den beiden Zeitpunkten auf die Minute abgeleitet,
 *       wie ihr Schreibweg rechnet.</li>
 * </ol>
 * Wer die Journale vereinheitlicht (AP-03 IP-7), findet diese drei Stellen hier.
 *
 * <p>Unter RLS: jede der drei Tabellen und jeder Namens-Join stehen im Mandantenzaun; eine
 * fremde Messstelle, ein fremdes Gerät und ein fremder Kundenbereich liefern 0 Zeilen (404
 * entscheidet der Dienst, nie 403).
 */
@Repository
public class AenderungsprotokollRepository {

    /** Die Zeitachse, nach der gefiltert und sortiert wird. */
    public enum Achse {
        /** Wann die Änderung GILT ({@code gilt_ab}) — die Vorgabe. */
        WIRKUNG("gilt_ab"),
        /** Wann sie EINGETRAGEN wurde ({@code created_at}). */
        EINTRAG("eingetragen_am");

        private final String spalte;

        Achse(String spalte) {
            this.spalte = spalte;
        }

        public String code() {
            return name().toLowerCase(java.util.Locale.ROOT);
        }

        static Achse aus(String code) {
            for (Achse a : values()) {
                if (a.code().equals(code)) {
                    return a;
                }
            }
            return null;
        }
    }

    /** Die drei Herkünfte — der Wert ist zugleich der stabile zweite Sortierschlüssel. */
    public static final String QUELLE_DATENQUELLE = "datenquelle";
    public static final String QUELLE_MESSSTELLE = "messstelle";
    public static final String QUELLE_ORT = "ort";

    /**
     * Eine Zeile des Lesemodells — die FAKTEN, noch ohne Kundensatz (den macht
     * {@link AenderungSatz}).
     *
     * @param quelle eine der drei {@code QUELLE_*}-Konstanten
     * @param id die laufende Nummer INNERHALB ihrer Tabelle — erst {@code quelle + id} ist eindeutig
     * @param bezugArt {@code messstelle} · {@code datenquelle} · {@code unternehmen} ·
     *     {@code standort} · {@code gebaeude} · {@code bereich} · {@code anlage}
     * @param bezugKennzeichen {@code MS-06}, {@code DQ-1}, das Kurzzeichen eines Ortes — oder
     *     {@code null}, wenn die Art keins trägt
     * @param rueckwirkend das Urteil des Schreibers (bei der Datenquelle abgeleitet, siehe Kopf)
     * @param urheberRolle {@code null} = nicht festgehalten (Orts-Einträge, siehe Kopf)
     */
    public record Zeile(String quelle, long id, String art, UUID bezugId, String bezugArt,
            String bezugKennzeichen, String bezugName, Instant giltAb, Instant eingetragenAm,
            boolean rueckwirkend, String grund, String ergebnis, String altJson, String neuJson,
            String urheberName, String urheberRolle, String urheberArt) {}

    /** Der Fortsetzungszeiger: die letzte gelieferte Zeile auf der gewählten Achse. */
    public record Zeiger(Instant zeit, String quelle, long id) {}

    private final JdbcTemplate jdbc;

    public AenderungsprotokollRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // ---------------------------------------------------------------- Die EINE Abfrage

    // Die Namen der Bezugsobjekte kommen über LEFT JOINs MIT — also nie über eine zweite
    // Abfrage je Zeile (keine N+1).

    /**
     * Der Zweig der Messstellen-Einträge — er trägt auch die vier JSON-Stellen, über die ein
     * Eintrag sein GERÄT nennt (siehe {@link #fuerEinbau}).
     */
    private static final String STROM_MESSSTELLE = """
            SELECT 'messstelle' AS quelle, a.id, a.art,
                   a.messstelle_id AS bezug_id, 'messstelle' AS bezug_art,
                   m.kennzeichen AS bezug_kennzeichen, m.name AS bezug_name,
                   a.gilt_ab, a.created_at AS eingetragen_am, a.rueckwirkend, a.grund,
                   NULL AS ergebnis, a.alt::text AS alt, a.neu::text AS neu,
                   a.actor_name AS urheber_name, a.actor_rolle AS urheber_rolle,
                   a.actor_art AS urheber_art,
                   coalesce(a.neu->>'einbau', a.alt->>'einbau', a.neu->>'vorgaenger',
                            a.neu->'beendet'->>'einbau') AS einbau,
                   coalesce(a.alt->>'einbau', a.neu->>'vorgaenger',
                            a.neu->'beendet'->>'einbau') AS einbau_zweit
              FROM messstelle_aenderung a
              LEFT JOIN messstelle m ON m.id = a.messstelle_id
            """;

    /** Der Zweig der Orts-Einträge — mit den drei Überbrückungen aus dem Kopf dieser Klasse. */
    private static final String STROM_ORT = """
            SELECT 'ort', o.id, o.art,
                   o.objekt_id, o.objekt_art,
                   coalesce(s.kurzzeichen, ok.kurzzeichen), coalesce(u.name, s.name, ok.name, si.name),
                   (o.gilt_ab::timestamp AT TIME ZONE ?::text), o.created_at, o.rueckwirkend, o.neu->>'begruendung',
                   NULL, o.alt::text, o.neu::text,
                   o.akteur_name,
                   NULL,
                   CASE WHEN o.akteur_name LIKE 'VoltPilot (%' THEN 'voltpilot' END,
                   NULL, NULL
              FROM ort_aenderung o
              LEFT JOIN unternehmen u ON o.objekt_art = 'unternehmen' AND u.id = o.objekt_id
              LEFT JOIN standort s ON o.objekt_art = 'standort' AND s.id = o.objekt_id
              LEFT JOIN ort ok ON o.objekt_art IN ('gebaeude', 'bereich') AND ok.id = o.objekt_id
              LEFT JOIN site si ON o.objekt_art = 'anlage' AND si.id = o.objekt_id
            """;

    /** Der Zweig der Datenquellen-Einträge — „rückwirkend" abgeleitet (siehe Kopf). */
    private static final String STROM_DATENQUELLE = """
            SELECT 'datenquelle', d.id, d.art,
                   d.data_source_id, 'datenquelle',
                   q.kennzeichen, q.name,
                   d.gilt_ab, d.created_at,
                   d.gilt_ab < date_trunc('minute', d.created_at), NULL,
                   d.ergebnis, d.alt::text, d.neu::text,
                   d.actor_name, d.actor_rolle, d.actor_art,
                   NULL, NULL
              FROM data_source_aenderung d
              LEFT JOIN data_source q ON q.id = d.data_source_id
            """;

    /** Das Protokoll EINER Messstelle, jüngster Eintrag zuerst — leer für eine fremde. */
    public List<Zeile> fuerMessstelle(UUID messstelleId, Instant von, Instant bis, Achse achse,
            int grenze, Zeiger nach) {
        return lies(STROM_MESSSTELLE, false, "bezug_id = ?", List.of(messstelleId), von, bis, achse,
                grenze, nach);
    }

    /**
     * Das Protokoll EINES Einbaus. Die Einträge, die ein Gerät betreffen, hängen an den
     * MESSSTELLEN, die es speist ({@code quelle_gebunden}, {@code quelle_beendet},
     * {@code einstellung_geaendert}, {@code zaehler_gewechselt}) — das Journal hat keine
     * Geräte-Spalte. Das Bindeglied ist das EINBAU-KENNZEICHEN, das jeder dieser Einträge in
     * seinem JSON nennt: {@code neu.einbau} (das Gerät, um das es geht), {@code alt.einbau}
     * (der Stand davor), {@code neu.vorgaenger} (das ausgebaute Gerät eines Wechsels) und
     * {@code neu.beendet.einbau} (die Bindung, die eine neue abgelöst hat). Ein Wechsel nennt
     * BEIDE Geräte und steht deshalb in beiden Protokollen — einmal als Abgang, einmal als
     * Zugang.
     *
     * <p>Das Kennzeichen ist je Kundenbereich eindeutig ({@code uq_geraet_einbau_kennzeichen},
     * V20260911200000) und wird nie weitergegeben — ein Wechsel legt eine NEUE
     * {@code geraet}-Zeile an, kein Schreibweg ändert ein bestehendes Kennzeichen. Wer die
     * Journale vereinheitlicht (AP-03 IP-7), darf hier eine echte Geräte-Spalte einsetzen.
     */
    public List<Zeile> fuerEinbau(String einbauKennzeichen, Instant von, Instant bis, Achse achse,
            int grenze, Zeiger nach) {
        return lies(STROM_MESSSTELLE, false, "? IN (einbau, einbau_zweit)", List.of(einbauKennzeichen),
                von, bis, achse, grenze, nach);
    }

    /** Das Protokoll des ganzen Unternehmens — alle drei Journale in EINER Abfrage. */
    public List<Zeile> fuerUnternehmen(Instant von, Instant bis, Achse achse, int grenze, Zeiger nach) {
        return lies(STROM_MESSSTELLE + "UNION ALL\n" + STROM_ORT + "UNION ALL\n" + STROM_DATENQUELLE,
                true, null, List.of(), von, bis, achse, grenze, nach);
    }

    /**
     * Die EINE Abfrage. Sortiert stabil nach {@code achse DESC, quelle ASC, id DESC} — das
     * Tripel ist eindeutig, auch wenn Einträge auf die Sekunde dieselbe Zeit tragen (bei einem
     * Zählerwechsel hat JEDE betroffene Messstelle denselben {@code gilt_ab}, und die laufenden
     * Nummern der drei Journale sind voneinander unabhängig). Genau dieses Tripel ist der
     * Fortsetzungszeiger — deshalb springt die Seitenweise nicht.
     *
     * <p>Der Rumpf steht in einem einfachen CTE, damit Filter, Sortierung und Zeiger die
     * berechneten Spalten nennen können; Postgres reicht ihn (eine Verwendung, keine
     * flüchtigen Funktionen) in die Zweige durch, sodass deren Indizes greifen.
     */
    private List<Zeile> lies(String strom, boolean zeitzone, String zusatz, List<Object> zusatzWerte,
            Instant von, Instant bis, Achse achse, int grenze, Zeiger nach) {
        String zeit = achse.spalte;
        StringBuilder sql = new StringBuilder("WITH e AS (\n").append(strom).append(")\nSELECT * FROM e WHERE 1 = 1");
        List<Object> werte = new ArrayList<>();
        if (zeitzone) {
            werte.add(MessstelleService.ZEITZONE.getId());
        }
        if (zusatz != null) {
            sql.append(" AND ").append(zusatz);
            werte.addAll(zusatzWerte);
        }
        if (von != null) {
            sql.append(" AND ").append(zeit).append(" >= ?");
            werte.add(Timestamp.from(von));
        }
        if (bis != null) {
            sql.append(" AND ").append(zeit).append(" < ?");
            werte.add(Timestamp.from(bis));
        }
        if (nach != null) {
            sql.append(" AND (").append(zeit).append(" < ? OR (").append(zeit)
                    .append(" = ? AND (quelle > ? OR (quelle = ? AND id < ?))))");
            werte.add(Timestamp.from(nach.zeit()));
            werte.add(Timestamp.from(nach.zeit()));
            werte.add(nach.quelle());
            werte.add(nach.quelle());
            werte.add(nach.id());
        }
        sql.append(" ORDER BY ").append(zeit).append(" DESC, quelle ASC, id DESC LIMIT ?");
        werte.add(grenze);
        return List.copyOf(jdbc.query(sql.toString(), AenderungsprotokollRepository::map, werte.toArray()));
    }

    private static Zeile map(ResultSet rs, int n) throws SQLException {
        return new Zeile(
                rs.getString("quelle"),
                rs.getLong("id"),
                rs.getString("art"),
                rs.getObject("bezug_id", UUID.class),
                rs.getString("bezug_art"),
                rs.getString("bezug_kennzeichen"),
                rs.getString("bezug_name"),
                rs.getTimestamp("gilt_ab").toInstant(),
                rs.getTimestamp("eingetragen_am").toInstant(),
                rs.getBoolean("rueckwirkend"),
                rs.getString("grund"),
                rs.getString("ergebnis"),
                rs.getString("alt"),
                rs.getString("neu"),
                rs.getString("urheber_name"),
                rs.getString("urheber_rolle"),
                rs.getString("urheber_art"));
    }
}
