package com.voltpilot.api.uems;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;
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
 *   <li><b>Urheber:</b> alle drei tragen {@code actor_sub/name/rolle/art} — {@code ort_aenderung}
 *       seit AP-03 IP-7 (V20260916010000, vorher {@code akteur_sub}/{@code akteur_name}). Die Rolle
 *       eines Orts-Eintrags aus der Zeit davor ist {@code NULL} = „nicht festgehalten" — nie
 *       geraten; seine Art hat die Migration aus dem Subject und dem Namen nachgetragen.</li>
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
 * <p><b>Die dritte Achse: die Gültigkeit (AP-02 IP-14, die Schnittstelle für AP-12).</b>
 * {@link Achse#GUELTIGKEIT} liefert die Einträge, deren Gültigkeit in den Zeitraum REICHT — die
 * Regel {@code reicht_in_zeitraum} des Ortsbaum-Vertrags ({@link OrtsbaumAbleitung#rueckwirkung}):
 * „gilt ab" ≤ letzter Tag UND (offen ODER „gilt bis" ≥ erster Tag), in Tagen. Ein Umzug, am 10.03.
 * eingetragen und gültig ab 01.02., steht deshalb in der Februar- UND in der März-Abfrage; mit
 * {@link Achse#WIRKUNG} stünde er nur im Februar. „gilt bis" eines Orts-Eintrags leitet der
 * Orts-Zweig aus dem Journal ab (siehe dort); Einträge der Messstellen und Datenquellen tragen
 * keins und reichen nur in den Tag, an dem sie wirken.
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
        EINTRAG("eingetragen_am"),
        /**
         * Welche Einträge in den Zeitraum REICHEN (AP-02 IP-14): sortiert wie {@link #WIRKUNG},
         * gefiltert in TAGEN über „gilt ab" und „gilt bis".
         */
        GUELTIGKEIT("gilt_ab");

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
     * @param giltBis der letzte Tag, an dem ein Orts-Eintrag noch gilt (siehe {@code STROM_ORT});
     *     {@code null} = offen — bei Messstellen und Datenquellen immer {@code null}
     */
    public record Zeile(String quelle, long id, String art, UUID bezugId, String bezugArt,
            String bezugKennzeichen, String bezugName, Instant giltAb, Instant eingetragenAm,
            boolean rueckwirkend, String grund, String ergebnis, String altJson, String neuJson,
            String urheberName, String urheberRolle, String urheberArt, LocalDate giltBis) {}

    /** Der Fortsetzungszeiger: die letzte gelieferte Zeile auf der gewählten Achse. */
    public record Zeiger(Instant zeit, String quelle, long id) {}

    /**
     * Was gelesen wird. Der Zeitraum steht für {@link Achse#WIRKUNG} und {@link Achse#EINTRAG} als
     * Zeitpunkte, halboffen {@code [von, bis)}; für {@link Achse#GUELTIGKEIT} als TAGE
     * {@code [vonTag, bisTag]}, beide zählen mit (Tagesgenaue Zuordnungen schließen den letzten Tag
     * ein). {@code null} = ohne Grenze.
     *
     * @param grenze wie viele Zeilen höchstens gelesen werden
     * @param nach der Fortsetzungszeiger der vorigen Seite; {@code null} = die erste
     */
    public record Filter(Instant von, Instant bis, LocalDate vonTag, LocalDate bisTag, Achse achse,
            int grenze, Zeiger nach) {}

    private final JdbcTemplate jdbc;

    public AenderungsprotokollRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // ---------------------------------------------------------------- Die EINE Abfrage

    // Die Namen der Bezugsobjekte kommen über LEFT JOINs MIT — also nie über eine zweite
    // Abfrage je Zeile (keine N+1). Jeder Zweig trägt am Ende „gilt ab" als Tag, „gilt bis" und ob
    // er die Gültigkeit ableitet — die Achse GUELTIGKEIT filtert darauf.

    /** Die Plattform-Zeitzone als SQL-Text — dieselbe, auf die „gilt ab" gehoben wird (Kopf). */
    private static final String ZONE = MessstelleService.ZEITZONE.getId();

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
                            a.neu->'beendet'->>'einbau') AS einbau_zweit,
                   (a.gilt_ab AT TIME ZONE '{zone}')::date AS gilt_ab_tag,
                   NULL::date AS gilt_bis, false AS gueltig_abgeleitet
              FROM messstelle_aenderung a
              LEFT JOIN messstelle m ON m.id = a.messstelle_id
            """.replace("{zone}", ZONE);

    /**
     * Der Zweig der Orts-Einträge — mit den drei Überbrückungen aus dem Kopf dieser Klasse und dem
     * „gilt bis" (AP-02 IP-14). Er trägt eigene Spaltennamen, weil ihn das Protokoll eines Ortes
     * und eines Standorts auch ALLEIN liest.
     *
     * <p><b>„gilt bis" aus dem Journal.</b> Ein Eintrag gilt, bis derselbe SACHVERHALT am selben
     * Objekt wieder geändert wird: bis zum Vortag des nächsten, SPÄTEREN „gilt ab" — zwei Einträge
     * desselben Tages (eine Korrektur) gelten beide. Die Sachverhalte:
     * <ul>
     *   <li>Zuordnung: {@code verschoben} · {@code korrigiert}; an der Anlage endet sie auch mit
     *       ihrem {@code geloescht}; am Standort zählt jede Anlage ({@code neu.anlage_id},
     *       hinzu/hinaus) für sich.</li>
     *   <li>Fläche: {@code flaeche_geaendert}.</li>
     *   <li>Bestehen: {@code angelegt} · {@code archiviert} · {@code wiederhergestellt}.</li>
     *   <li>Felder: ein {@code bearbeitet} endet erst, wenn EIN späterer {@code bearbeitet} ALLE
     *       seine Felder neu setzt.</li>
     *   <li>Zugriff ({@code zugriff_zugewiesen} · {@code zugriff_entzogen}, AP-03 IP-9): ein PUNKT — er gilt
     *       an seinem Tag und wird von nichts abgelöst. Ohne diese Ausnahme bliebe er offen und stünde in
     *       jedem späteren Zeitraum.</li>
     * </ul>
     * Ein geplantes Ende des Eintrags selbst ({@code neu.gueltig_bis}) kürzt zusätzlich. Das
     * Löschen eines Kindes (steht am Elternknoten und nennt {@code alt.id}) gilt nur an seinem Tag.
     * Eine Art ohne Sachverhalt bleibt offen — lieber ein Eintrag zu viel im Zeitraum als einer zu
     * wenig. Die Formel „reicht in den Zeitraum" selbst ist die des Ortsbaum-Vertrags
     * ({@link OrtsbaumAbleitung#rueckwirkung}); {@code OrtAenderungenApiTest} hält beide gleich.
     */
    private static final String STROM_ORT = """
            SELECT 'ort' AS quelle, o.id, o.art,
                   o.objekt_id AS bezug_id, o.objekt_art AS bezug_art,
                   coalesce(s.kurzzeichen, ok.kurzzeichen) AS bezug_kennzeichen,
                   coalesce(u.name, s.name, ok.name, si.name) AS bezug_name,
                   (o.gilt_ab::timestamp AT TIME ZONE ?::text) AS gilt_ab, o.created_at AS eingetragen_am,
                   o.rueckwirkend, o.neu->>'begruendung' AS grund,
                   NULL AS ergebnis, o.alt::text AS alt, o.neu::text AS neu,
                   o.actor_name AS urheber_name, o.actor_rolle AS urheber_rolle,
                   o.actor_art AS urheber_art,
                   NULL AS einbau, NULL AS einbau_zweit,
                   o.gilt_ab AS gilt_ab_tag,
                   CASE WHEN o.art IN ('zugriff_zugewiesen', 'zugriff_entzogen', 'rolle_gesetzt', 'rolle_entzogen')
                             OR (o.art = 'geloescht' AND jsonb_exists(coalesce(o.alt, '{}'::jsonb), 'id'))
                        THEN o.gilt_ab
                        ELSE least(
                            (SELECT min(n.gilt_ab) FROM ort_aenderung n
                              WHERE n.objekt_art = o.objekt_art AND n.objekt_id = o.objekt_id
                                AND n.gilt_ab > o.gilt_ab
                                AND CASE
                                    WHEN o.art IN ('verschoben', 'korrigiert')
                                         AND jsonb_exists(coalesce(o.neu, '{}'::jsonb), 'anlage_id')
                                        THEN n.art IN ('verschoben', 'korrigiert')
                                             AND n.neu->>'anlage_id' = o.neu->>'anlage_id'
                                    WHEN o.art IN ('verschoben', 'korrigiert')
                                        THEN (n.art IN ('verschoben', 'korrigiert')
                                              AND NOT jsonb_exists(coalesce(n.neu, '{}'::jsonb), 'anlage_id'))
                                          OR (n.art = 'geloescht'
                                              AND NOT jsonb_exists(coalesce(n.alt, '{}'::jsonb), 'id'))
                                    WHEN o.art = 'flaeche_geaendert' THEN n.art = 'flaeche_geaendert'
                                    WHEN o.art IN ('angelegt', 'archiviert', 'wiederhergestellt')
                                        THEN n.art IN ('archiviert', 'wiederhergestellt')
                                    WHEN o.art = 'bearbeitet'
                                        THEN n.art = 'bearbeitet'
                                             AND jsonb_exists_all(coalesce(n.neu, '{}'::jsonb),
                                                 ARRAY(SELECT jsonb_object_keys(coalesce(o.neu, '{}'::jsonb))))
                                    ELSE false
                                END) - 1,
                            CASE WHEN o.neu->>'gueltig_bis' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                                 THEN (o.neu->>'gueltig_bis')::date END)
                   END AS gilt_bis,
                   true AS gueltig_abgeleitet
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
                   NULL, NULL,
                   (d.gilt_ab AT TIME ZONE '{zone}')::date, NULL::date, false
              FROM data_source_aenderung d
              LEFT JOIN data_source q ON q.id = d.data_source_id
            """.replace("{zone}", ZONE);

    /** Das Protokoll EINER Messstelle, jüngster Eintrag zuerst — leer für eine fremde. */
    public List<Zeile> fuerMessstelle(UUID messstelleId, Filter f) {
        return lies(STROM_MESSSTELLE, false, "bezug_id = ?", List.of(messstelleId), f);
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
    public List<Zeile> fuerEinbau(String einbauKennzeichen, Filter f) {
        return lies(STROM_MESSSTELLE, false, "? IN (einbau, einbau_zweit)", List.of(einbauKennzeichen), f);
    }

    /** Das Protokoll des ganzen Unternehmens — alle drei Journale in EINER Abfrage. */
    public List<Zeile> fuerUnternehmen(Filter f) {
        return lies(STROM_MESSSTELLE + "UNION ALL\n" + STROM_ORT + "UNION ALL\n" + STROM_DATENQUELLE,
                true, null, List.of(), f);
    }

    /** Die Einträge einer Anlage, einschließlich ihrer sofortigen Rollenänderungen. */
    public List<Zeile> fuerAnlage(UUID siteId, Filter f) {
        return lies(STROM_ORT, true, "bezug_art = 'anlage' AND bezug_id = ?", List.of(siteId), f);
    }

    /** Eigene Orts-Einträge; das Löschen eines Bereichs steht an seinem Gebäude. */
    public List<Zeile> fuerOrt(UUID ortId, Filter f) {
        return lies(STROM_ORT, true, "bezug_art IN ('gebaeude', 'bereich') AND bezug_id = ?", List.of(ortId), f);
    }

    /**
     * Genau diese Orts-Einträge (AP-02 IP-14) — WELCHE zu einem Standort gehören, entscheidet
     * {@link OrtProtokollUmfang}; hier wird nur gelesen, gefiltert, sortiert und geseitet wie
     * überall, damit die Seitenweise dieselbe bleibt.
     */
    public List<Zeile> fuerOrtEintraege(Collection<Long> ids, Filter f) {
        if (ids.isEmpty()) {
            return List.of();
        }
        String liste = ids.stream().sorted().map(String::valueOf).collect(Collectors.joining(",", "{", "}"));
        return lies(STROM_ORT, true, "id = ANY(?::bigint[])", List.of(liste), f);
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
    private List<Zeile> lies(String strom, boolean zeitzone, String zusatz, List<Object> zusatzWerte, Filter f) {
        String zeit = f.achse().spalte;
        StringBuilder sql = new StringBuilder("WITH e AS (\n").append(strom).append(")\nSELECT * FROM e WHERE 1 = 1");
        List<Object> werte = new ArrayList<>();
        if (zeitzone) {
            werte.add(ZONE);
        }
        if (zusatz != null) {
            sql.append(" AND ").append(zusatz);
            werte.addAll(zusatzWerte);
        }
        if (f.achse() == Achse.GUELTIGKEIT) {
            // `reicht_in_zeitraum` des Ortsbaum-Vertrags: gilt ab ≤ letzter Tag UND (offen ODER
            // gilt bis ≥ erster Tag). Ohne abgeleitete Gültigkeit reicht ein Eintrag nur in seinen Tag.
            if (f.bisTag() != null) {
                sql.append(" AND gilt_ab_tag <= ?");
                werte.add(f.bisTag());
            }
            if (f.vonTag() != null) {
                sql.append(" AND CASE WHEN gueltig_abgeleitet THEN gilt_bis IS NULL OR gilt_bis >= ?"
                        + " ELSE gilt_ab_tag >= ? END");
                werte.add(f.vonTag());
                werte.add(f.vonTag());
            }
        } else {
            if (f.von() != null) {
                sql.append(" AND ").append(zeit).append(" >= ?");
                werte.add(Timestamp.from(f.von()));
            }
            if (f.bis() != null) {
                sql.append(" AND ").append(zeit).append(" < ?");
                werte.add(Timestamp.from(f.bis()));
            }
        }
        Zeiger nach = f.nach();
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
        werte.add(f.grenze());
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
                rs.getString("urheber_art"),
                rs.getObject("gilt_bis", LocalDate.class));
    }
}
