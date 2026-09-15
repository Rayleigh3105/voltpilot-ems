package com.voltpilot.api.uems;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.ZoneId;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Lesen und Schreiben der Berichts-Tabellen (UEMS AP-12 IP-4) für die Routen (IP-7) — als Anwendungsrolle unter RLS, nur
 * mit den Rechten, die IP-4 ihr gab: Bericht anlegen und archivieren, Stand und seine Quellen anhängen, am Vorgänger
 * „ersetzt durch“ setzen, Anstöße abschließen, Protokoll anhängen. Den Entwurf schreibt allein
 * {@link BerichtAbzugBildung}.
 *
 * <p>Der Abzug eines Stands wird in SQL aus dem Entwurf kopiert ({@link #standEinfrieren}) — kein Umweg über Java, damit
 * der Stand Byte für Byte der Entwurf ist (E1, F2).
 */
@Repository
public class BerichtRepository {

    private final JdbcTemplate jdbc;
    private final NamedParameterJdbcTemplate benannt;

    public BerichtRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
        this.benannt = new NamedParameterJdbcTemplate(jdbc);
    }

    /** Ein Bericht mit dem Namen seiner Geltung. */
    public record Kopf(UUID id, UUID tenant, String kennung, String vorlage, int vorlageFassung, String geltungArt,
            UUID standortId, UUID unternehmenId, String geltungName, String zeitraumArt, String schluessel, String zeitzone,
            String angelegtVonSub, String angelegtVonName, Instant angelegtAm, Instant archiviertAm) {

        public UUID geltungId() {
            return standortId != null ? standortId : unternehmenId;
        }

        public ZoneId zone() {
            return ZoneId.of(zeitzone);
        }
    }

    public record EntwurfZeile(String abzug, String pruefsumme, Instant datenstand, String gebildetVon) {}

    /** Ein Stand; {@code abzug}, {@code darstellung} und {@code regelwerk} nur, wenn ausdrücklich gelesen. */
    public record StandZeile(UUID id, int nr, String abzug, String pruefsumme, Instant datenstand, Instant freigegebenAm,
            String freigeberSub, String freigeberName, String freigeberRolle, String darstellung, String regelwerk,
            int vorlageFassung, Integer ersetztDurchNr, UUID anlassAnstossId) {}

    public record AnstossZeile(UUID id, UUID standId, int nr, String art, String anlassKennung, Integer anlassFassung,
            Instant erkanntAm, String zustand, Integer erledigtDurchNr, String verworfenBegruendung, String verworfenVonSub,
            String verworfenVonName, Instant verworfenAm) {}

    /** Ein Standort oder das Unternehmen als Geltung. */
    public record Geltung(UUID id, String name, String zeitzone) {}

    private static final String KOPF = "SELECT b.id, b.tenant_id, b.kennung, b.vorlage, b.vorlage_fassung, b.geltung_art, "
            + "b.standort_id, b.unternehmen_id, coalesce(st.name, u.name) AS geltung_name, b.zeitraum_art, "
            + "b.zeitraum_schluessel, b.zeitzone, b.angelegt_von_sub, b.angelegt_von_name, b.angelegt_am, b.archiviert_am "
            + "FROM bericht b LEFT JOIN standort st ON st.id = b.standort_id AND st.tenant_id = b.tenant_id "
            + "LEFT JOIN unternehmen u ON u.id = b.unternehmen_id AND u.tenant_id = b.tenant_id ";

    private static final String STAND = "SELECT id, nr, %s pruefsumme, datenstand, freigegeben_am, freigeber_sub, "
            + "freigeber_name, freigeber_rolle, %s vorlage_fassung, ersetzt_durch_nr, anlass_anstoss_id FROM bericht_stand ";

    private static final String ANSTOSS = "SELECT a.id, a.stand_id, s.nr, a.art, a.anlass_kennung, a.anlass_fassung, "
            + "a.erkannt_am, a.zustand, a.erledigt_durch_nr, a.verworfen_begruendung, a.verworfen_von_sub, "
            + "a.verworfen_von_name, a.verworfen_am FROM bericht_revision_anstoss a "
            + "JOIN bericht_stand s ON s.id = a.stand_id AND s.tenant_id = a.tenant_id ";

    // ================================================================================ Bericht

    public Optional<Kopf> bericht(String kennung) {
        return jdbc.query(KOPF + "WHERE b.kennung = ?", BerichtRepository::kopf, kennung).stream().findFirst();
    }

    /** Die nicht archivierten Berichte, neueste zuerst (V4: Archivieren verbirgt in der Liste). */
    public List<Kopf> berichte() {
        return jdbc.query(KOPF + "WHERE b.archiviert_am IS NULL ORDER BY b.angelegt_am DESC, b.kennung DESC",
                BerichtRepository::kopf);
    }

    /** V4 — der Bericht zu Vorlage × Geltung × Zeitraum, auch ein archivierter. */
    public Optional<Kopf> berichtZu(String vorlage, String geltungArt, UUID geltung, String schluessel) {
        return jdbc.query(KOPF + "WHERE b.vorlage = ? AND b.geltung_art = ? AND b.geltung_id = ? AND b.zeitraum_schluessel = ?",
                BerichtRepository::kopf, vorlage, geltungArt, geltung, schluessel).stream().findFirst();
    }

    /** Sperrt die Bericht-Zeile bis zum Ende der Transaktion: Freigabe und Archivieren eines Berichts nacheinander. */
    public void sperren(UUID tenant, UUID bericht) {
        // NO KEY UPDATE: ein Fremdschlüssel-Prüfen (Kaskade schreibt Quellen) wartet nicht darauf.
        jdbc.queryForList("SELECT id FROM bericht WHERE tenant_id = ? AND id = ? FOR NO KEY UPDATE", UUID.class, tenant,
                bericht);
    }

    /** {@code BR-<Jahr>-<Nr.>} über {@code uems_bericht_kennung} (IP-4). */
    public String kennungNeu(UUID tenant, int jahr) {
        return jdbc.queryForObject("SELECT uems_bericht_kennung(?, ?)", String.class, tenant, jahr);
    }

    public UUID anlegen(UUID tenant, String kennung, BerichtRegeln.Vorlage vorlage, UUID geltung, String schluessel,
            ZoneId zone, ProtokollAkteur wer, Instant jetzt) {
        boolean standort = BerichtRegeln.STANDORT.equals(vorlage.geltungArt());
        return jdbc.queryForObject("INSERT INTO bericht (tenant_id, kennung, vorlage, vorlage_fassung, geltung_art, "
                + "standort_id, unternehmen_id, zeitraum_art, zeitraum_schluessel, zeitzone, angelegt_von_sub, "
                + "angelegt_von_name, angelegt_am) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", UUID.class,
                tenant, kennung, vorlage.schluessel(), vorlage.fassung(), vorlage.geltungArt(), standort ? geltung : null,
                standort ? null : geltung, vorlage.zeitraumArt(), schluessel, zone.getId(), wer.sub(), wer.name(),
                Timestamp.from(jetzt));
    }

    /** V3 — die Kennzeichen der genannten Kennzahlen des Kundenbereichs; eine unbekannte oder fremde fehlt in der Antwort. */
    public Map<UUID, String> kennzahlenDesKundenbereichs(UUID tenant, Collection<UUID> kennzahlen) {
        Map<UUID, String> aus = new LinkedHashMap<>();
        jdbc.query("SELECT id, kennzeichen FROM kennzahl WHERE tenant_id = ? AND id = ANY (?::uuid[])", rs -> {
            aus.put(rs.getObject("id", UUID.class), rs.getString("kennzeichen"));
        }, tenant, kennzahlen.stream().map(UUID::toString).toArray(String[]::new));
        return aus;
    }

    /**
     * V3 — je Kennzahl eine wirksame Abwahl ({@code bericht_kennzahl_abwahl}; keine Zeile = gewählt). Beim Anlegen vor der
     * ersten Bildung, damit schon der erste Entwurf sie weglässt.
     */
    public void abwaehlen(UUID tenant, UUID bericht, Collection<UUID> kennzahlen, ProtokollAkteur wer, Instant jetzt) {
        for (UUID kennzahl : kennzahlen) {
            jdbc.update("INSERT INTO bericht_kennzahl_abwahl (tenant_id, bericht_id, kennzahl_id, abgewaehlt_am, "
                    + "abgewaehlt_von_sub, abgewaehlt_von_name) VALUES (?, ?, ?, ?, ?, ?)", tenant, bericht, kennzahl,
                    Timestamp.from(jetzt), wer.sub(), wer.name());
        }
    }

    /** Setzt „archiviert am“ genau einmal; {@code false} = war schon archiviert. */
    public boolean archivieren(UUID tenant, UUID bericht, Instant jetzt) {
        return jdbc.update("UPDATE bericht SET archiviert_am = ? WHERE tenant_id = ? AND id = ? AND archiviert_am IS NULL",
                Timestamp.from(jetzt), tenant, bericht) == 1;
    }

    // ================================================================================ Geltung

    /** Die Standorte des Kundenbereichs in der Folge, in der die Rechte-Ableitung sie sieht. */
    public List<Geltung> standorte() {
        return jdbc.query("SELECT id, name, zeitzone FROM standort ORDER BY name, id",
                (rs, i) -> new Geltung(rs.getObject("id", UUID.class), rs.getString("name"), rs.getString("zeitzone")));
    }

    public Optional<Geltung> unternehmen() {
        return jdbc.query("SELECT id, name, zeitzone FROM unternehmen ORDER BY id LIMIT 1",
                (rs, i) -> new Geltung(rs.getObject("id", UUID.class), rs.getString("name"), rs.getString("zeitzone")))
                .stream().findFirst();
    }

    /** Die Zeitzone eines Standorts, sonst die des Unternehmens, sonst Europe/Berlin (Muster Kennzahl). */
    public ZoneId zeitzone(UUID standort) {
        return ZoneId.of(jdbc.queryForObject("SELECT coalesce((SELECT s.zeitzone FROM standort s WHERE s.id = ?), "
                + "(SELECT u.zeitzone FROM unternehmen u ORDER BY u.id LIMIT 1), 'Europe/Berlin')", String.class, standort));
    }

    // ================================================================================ Entwurf

    /** Der gespeicherte Entwurf; {@code sperre} = {@code ""}, {@code "FOR SHARE"} (Freigabe) oder {@code "FOR UPDATE"}. */
    public Optional<EntwurfZeile> entwurf(UUID tenant, UUID bericht, String sperre) {
        if (!List.of("", "FOR SHARE", "FOR UPDATE").contains(sperre)) {
            throw new IllegalArgumentException("Sperre " + sperre);
        }
        return jdbc.query("SELECT abzug, pruefsumme, datenstand, gebildet_von FROM bericht_entwurf "
                + "WHERE tenant_id = ? AND bericht_id = ? " + sperre,
                (rs, i) -> new EntwurfZeile(rs.getString("abzug"), rs.getString("pruefsumme"),
                        rs.getTimestamp("datenstand").toInstant(), rs.getString("gebildet_von")), tenant, bericht)
                .stream().findFirst();
    }

    /** Der Datenstand des Entwurfs ohne den Abzug — für Liste und Kopf. */
    public Optional<Instant> entwurfDatenstand(UUID tenant, UUID bericht) {
        return jdbc.query("SELECT datenstand FROM bericht_entwurf WHERE tenant_id = ? AND bericht_id = ?",
                (rs, i) -> rs.getTimestamp(1).toInstant(), tenant, bericht).stream().findFirst();
    }

    /**
     * Der Anlass der letzten Neubildung eines Entwurfs zu diesem Datenstand — aus der Meldung
     * {@code bericht_entwurf_neu_gebildet} (Kaskade, Strukturläufer); {@code null}, wenn keine ihn nennt.
     */
    public String anlassDerNeubildung(UUID tenant, String kennung, Instant datenstand) {
        return jdbc.query("SELECT nutzlast->>'anlass_kennung' FROM messreihe_ereignis WHERE tenant_id = ? "
                + "AND art = 'bericht_entwurf_neu_gebildet' AND kennungen->>'bericht' = ? "
                + "AND (nutzlast->>'datenstand')::timestamptz = ? ORDER BY zeit DESC LIMIT 1",
                (rs, i) -> rs.getString(1), tenant, kennung, Timestamp.from(datenstand)).stream()
                .filter(k -> k != null).findFirst().orElse(null);
    }

    /**
     * D4 — was sich an den Quellen des Entwurfs nach {@code datenstand} geändert hat: neue Versionen (Kaskade), neu oder
     * nachgezogen gerechnete Perioden (auch vorläufig und Version 1), Kennzahl-Werte, Bezugsgrößen-Fassungen, neue
     * Quellenbindungen und — für den ganzen Kundenbereich, weil eine Messstelle auch neu zur Geltung kommen kann — jede
     * Orts- und Messstellen-Änderung, die bis in den Zeitraum zurückwirkt. Eine Abfrage, kein Neurechnen; lieber einmal zu
     * oft neu gebildet als eine Zahl übersehen (Tagesgrenzen um einen Tag geweitet).
     */
    public List<BerichtRegeln.Aenderung> aenderungenSeit(UUID tenant, UUID bericht, Instant datenstand) {
        MapSqlParameterSource p = new MapSqlParameterSource(Map.of("t", tenant, "b", bericht, "ds", Timestamp.from(datenstand)));
        return benannt.query("""
                WITH q AS (
                    SELECT kennzeichen, art, objekt_id, erster_tag, letzter_tag FROM bericht_quelle
                     WHERE tenant_id = :t AND bericht_id = :b AND stand_nr IS NULL),
                reihe AS (
                    SELECT DISTINCT q.kennzeichen, mq.entity_id, q.erster_tag, q.letzter_tag
                      FROM q JOIN messstelle_quelle mq ON mq.tenant_id = :t AND mq.messstelle_id = q.objekt_id
                     WHERE q.art = 'messstelle'),
                zeitraum AS (SELECT min(erster_tag) AS erster_tag, max(letzter_tag) AS letzter_tag FROM q)
                SELECT kennzeichen, art, zeitpunkt FROM (
                    SELECT q.kennzeichen, 'version' AS art, greatest(v.created_at, coalesce(v.nachgezogen_am, v.created_at)) AS zeitpunkt
                      FROM q JOIN messreihe_periode_version v ON v.tenant_id = :t AND v.messstelle_id = q.objekt_id
                     WHERE q.art = 'messstelle' AND v.periode_beginn < q.letzter_tag + 2 AND v.periode_ende > q.erster_tag - 1
                    UNION ALL
                    SELECT r.kennzeichen, 'version', greatest(v.created_at, coalesce(v.nachgezogen_am, v.created_at))
                      FROM reihe r JOIN messreihe_periode_version v ON v.tenant_id = :t AND v.entity_id = r.entity_id
                     WHERE v.periode_beginn < r.letzter_tag + 2 AND v.periode_ende > r.erster_tag - 1
                    UNION ALL
                    SELECT r.kennzeichen, 'version', v.created_at
                      FROM reihe r JOIN messreihe_viertelstunde_version v ON v.tenant_id = :t AND v.entity_id = r.entity_id
                     WHERE v.intervall_beginn >= r.erster_tag - 1 AND v.intervall_beginn < r.letzter_tag + 2
                    UNION ALL
                    SELECT q.kennzeichen, 'berechnet_am', p.berechnet_am
                      FROM q JOIN messreihe_periode p ON p.tenant_id = :t AND p.messstelle_id = q.objekt_id
                     WHERE q.art = 'messstelle' AND p.tag <= q.letzter_tag AND p.tag > q.erster_tag - 366
                    UNION ALL
                    SELECT r.kennzeichen, 'berechnet_am', p.berechnet_am
                      FROM reihe r JOIN messreihe_periode p ON p.tenant_id = :t AND p.entity_id = r.entity_id
                     WHERE p.tag <= r.letzter_tag AND p.tag > r.erster_tag - 366
                    UNION ALL
                    SELECT q.kennzeichen, 'berechnet_am', d.berechnet_am
                      FROM q JOIN messreihe_tag d ON d.tenant_id = :t AND d.messstelle_id = q.objekt_id
                     WHERE q.art = 'messstelle' AND d.tag BETWEEN q.erster_tag AND q.letzter_tag
                    UNION ALL
                    SELECT r.kennzeichen, 'berechnet_am', d.berechnet_am
                      FROM reihe r JOIN messreihe_tag d ON d.tenant_id = :t AND d.entity_id = r.entity_id
                     WHERE d.tag BETWEEN r.erster_tag AND r.letzter_tag
                    UNION ALL
                    SELECT q.kennzeichen, 'messstelle_quelle', mq.created_at
                      FROM q JOIN messstelle_quelle mq ON mq.tenant_id = :t AND mq.messstelle_id = q.objekt_id
                     WHERE q.art = 'messstelle' AND mq.gueltig_ab < q.letzter_tag + 2
                    UNION ALL
                    SELECT q.kennzeichen, 'kennzahl_wert', k.berechnet_am
                      FROM q JOIN kennzahl_wert k ON k.tenant_id = :t AND k.kennzahl_id = q.objekt_id
                     WHERE q.art = 'kennzahl' AND k.periode_von <= q.letzter_tag AND k.periode_bis >= q.erster_tag
                    UNION ALL
                    SELECT q.kennzeichen, 'bezugsgroesse_wert', w.created_at
                      FROM q JOIN bezugsgroesse_wert w ON w.tenant_id = :t AND w.bezugsgroesse_id = q.objekt_id
                     WHERE q.art = 'bezugsgroesse'
                    UNION ALL
                    SELECT NULL, 'messstelle_aenderung', a.created_at
                      FROM messstelle_aenderung a, zeitraum z
                     WHERE a.tenant_id = :t AND a.gilt_ab < z.letzter_tag + 2
                    UNION ALL
                    SELECT NULL, 'ort_aenderung', o.created_at
                      FROM ort_aenderung o, zeitraum z
                     WHERE o.tenant_id = :t AND o.gilt_ab <= z.letzter_tag + 1
                ) x
                WHERE zeitpunkt > :ds
                ORDER BY zeitpunkt, kennzeichen
                """, p, (rs, i) -> new BerichtRegeln.Aenderung(rs.getString("kennzeichen"), rs.getString("art"),
                        rs.getTimestamp("zeitpunkt").toInstant()));
    }

    // ================================================================================ Stand

    /** Die Stände ohne Abzug, Nr. 1 zuerst. */
    public List<StandZeile> staende(UUID tenant, UUID bericht) {
        return jdbc.query(STAND.formatted("NULL AS abzug,", "NULL AS darstellung, NULL AS regelwerk,")
                + "WHERE tenant_id = ? AND bericht_id = ? ORDER BY nr", BerichtRepository::stand, tenant, bericht);
    }

    /** Ein Stand mit Abzug, Darstellung und Regelwerk als gespeicherter Text. */
    public Optional<StandZeile> stand(UUID tenant, UUID bericht, int nr) {
        return jdbc.query(STAND.formatted("abzug,", "darstellung::text AS darstellung, regelwerk::text AS regelwerk,")
                + "WHERE tenant_id = ? AND bericht_id = ? AND nr = ?", BerichtRepository::stand, tenant, bericht, nr)
                .stream().findFirst();
    }

    /** F5 — der Stand, der aus dem Entwurf mit genau diesem Datenstand entstand. */
    public Optional<Integer> standZumDatenstand(UUID tenant, UUID bericht, Instant datenstand) {
        return jdbc.queryForList("SELECT nr FROM bericht_stand WHERE tenant_id = ? AND bericht_id = ? AND datenstand = ? "
                + "ORDER BY nr DESC LIMIT 1", Integer.class, tenant, bericht, Timestamp.from(datenstand)).stream().findFirst();
    }

    /**
     * F2/F3 — kopiert den Entwurf mit genau diesem Datenstand in SQL nach {@code bericht_stand}: Abzug und Prüfsumme
     * Byte für Byte, dazu Person, Zeitpunkt, eingefrorene Darstellung, Regelwerk, Vorlagen-Fassung und Anlass. Leer, wenn
     * es den Entwurf so nicht (mehr) gibt.
     */
    public Optional<UUID> standEinfrieren(UUID tenant, UUID bericht, int nr, Instant datenstand, Instant freigegebenAm,
            ProtokollAkteur wer, String rolle, String darstellung, String regelwerk, int vorlageFassung, UUID anlass) {
        return jdbc.queryForList("INSERT INTO bericht_stand (tenant_id, bericht_id, nr, abzug, pruefsumme, datenstand, "
                + "freigegeben_am, freigeber_sub, freigeber_name, freigeber_rolle, darstellung, regelwerk, vorlage_fassung, "
                + "anlass_anstoss_id) SELECT e.tenant_id, e.bericht_id, ?, e.abzug, e.pruefsumme, e.datenstand, ?, ?, ?, ?, "
                + "?::jsonb, ?::jsonb, ?, ? FROM bericht_entwurf e WHERE e.tenant_id = ? AND e.bericht_id = ? "
                + "AND e.datenstand = ? RETURNING id", UUID.class, nr, Timestamp.from(freigegebenAm), wer.sub(), wer.name(),
                rolle, darstellung, regelwerk, vorlageFassung, anlass, tenant, bericht, Timestamp.from(datenstand))
                .stream().findFirst();
    }

    /** F2 — die Quellen des Entwurfs werden die Quellen des Stands (Q6), unverändert. */
    public int quellenEinfrieren(UUID tenant, UUID bericht, int nr) {
        return jdbc.update("INSERT INTO bericht_quelle (tenant_id, bericht_id, stand_nr, art, kennzeichen, objekt_id, bezug, "
                + "erster_tag, letzter_tag, version, fassung, name_zum_datenstand) SELECT tenant_id, bericht_id, ?, art, "
                + "kennzeichen, objekt_id, bezug, erster_tag, letzter_tag, version, fassung, name_zum_datenstand "
                + "FROM bericht_quelle WHERE tenant_id = ? AND bericht_id = ? AND stand_nr IS NULL ORDER BY kennzeichen, bezug",
                nr, tenant, bericht);
    }

    /** R2 — am bisher gültigen Stand „ersetzt durch Nr. n“, genau einmal (Trigger). */
    public void ersetzen(UUID tenant, UUID bericht, int alteNr, int neueNr) {
        jdbc.update("UPDATE bericht_stand SET ersetzt_durch_nr = ? WHERE tenant_id = ? AND bericht_id = ? AND nr = ? "
                + "AND ersetzt_durch_nr IS NULL", neueNr, tenant, bericht, alteNr);
    }

    // ================================================================================ Anstoß

    /** Die Anstöße aller Stände, älteste zuerst. */
    public List<AnstossZeile> anstoesse(UUID tenant, UUID bericht) {
        return jdbc.query(ANSTOSS + "WHERE a.tenant_id = ? AND s.bericht_id = ? ORDER BY a.erkannt_am, a.id",
                BerichtRepository::anstoss, tenant, bericht);
    }

    public Optional<AnstossZeile> anstoss(UUID tenant, UUID bericht, UUID id) {
        return jdbc.query(ANSTOSS + "WHERE a.tenant_id = ? AND s.bericht_id = ? AND a.id = ?", BerichtRepository::anstoss,
                tenant, bericht, id).stream().findFirst();
    }

    /** R3 — die Revision Nr. n erledigt jeden offenen Anstoß des Berichts. */
    public int anstoesseErledigen(UUID tenant, UUID bericht, int nr) {
        return jdbc.update("UPDATE bericht_revision_anstoss a SET zustand = 'erledigt', erledigt_durch_nr = ? "
                + "FROM bericht_stand s WHERE s.id = a.stand_id AND s.tenant_id = a.tenant_id AND a.tenant_id = ? "
                + "AND s.bericht_id = ? AND a.zustand = 'offen'", nr, tenant, bericht);
    }

    /** R4 — verwirft einen OFFENEN Anstoß; {@code false} = er war es nicht mehr. */
    public boolean verwerfen(UUID tenant, UUID id, String begruendung, ProtokollAkteur wer, Instant jetzt) {
        return jdbc.update("UPDATE bericht_revision_anstoss SET zustand = 'verworfen', verworfen_begruendung = ?, "
                + "verworfen_von_sub = ?, verworfen_von_name = ?, verworfen_am = ? WHERE tenant_id = ? AND id = ? "
                + "AND zustand = 'offen'", begruendung, wer.sub(), wer.name(), Timestamp.from(jetzt), tenant, id) == 1;
    }

    // ================================================================================ Abrufe

    /** DA5 — ein Abruf einer Ausgabe eines Stands (append-only); seine Kennung ist auch die der Meldung. */
    public UUID abruf(UUID tenant, UUID stand, String format, boolean teilansicht, ProtokollAkteur wer, String rolle,
            Instant jetzt) {
        return jdbc.queryForObject("INSERT INTO bericht_abruf (tenant_id, stand_id, format, teilansicht, actor_sub, "
                + "actor_name, actor_rolle, actor_art, abgerufen_am) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
                UUID.class, tenant, stand, format, teilansicht, wer.sub(), wer.name(), rolle, wer.art(),
                Timestamp.from(jetzt));
    }

    // ================================================================================ Protokoll

    /** Ein Eintrag in {@code bericht_aenderung}; {@code art} ist ein Wort aus {@code handlung}. */
    public void protokoll(UUID tenant, UUID bericht, Integer standNr, String art, String alt, String neu, String grund,
            ProtokollAkteur wer, String rolle, Instant jetzt) {
        jdbc.update("INSERT INTO bericht_aenderung (tenant_id, bericht_id, stand_nr, art, alt, neu, grund, actor_sub, "
                + "actor_name, actor_rolle, actor_art, created_at) VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?, ?)",
                tenant, bericht, standNr, art, alt, neu, grund, wer.sub(), wer.name(), rolle, wer.art(),
                Timestamp.from(jetzt));
    }

    // ================================================================================ Zeilen

    private static Kopf kopf(ResultSet rs, int i) throws SQLException {
        return new Kopf(rs.getObject("id", UUID.class), rs.getObject("tenant_id", UUID.class), rs.getString("kennung"),
                rs.getString("vorlage"), rs.getInt("vorlage_fassung"), rs.getString("geltung_art"),
                rs.getObject("standort_id", UUID.class), rs.getObject("unternehmen_id", UUID.class),
                rs.getString("geltung_name"), rs.getString("zeitraum_art"), rs.getString("zeitraum_schluessel"),
                rs.getString("zeitzone"), rs.getString("angelegt_von_sub"), rs.getString("angelegt_von_name"),
                zeit(rs, "angelegt_am"), zeit(rs, "archiviert_am"));
    }

    private static StandZeile stand(ResultSet rs, int i) throws SQLException {
        return new StandZeile(rs.getObject("id", UUID.class), rs.getInt("nr"), rs.getString("abzug"),
                rs.getString("pruefsumme"), zeit(rs, "datenstand"), zeit(rs, "freigegeben_am"), rs.getString("freigeber_sub"),
                rs.getString("freigeber_name"), rs.getString("freigeber_rolle"), rs.getString("darstellung"),
                rs.getString("regelwerk"), rs.getInt("vorlage_fassung"), (Integer) rs.getObject("ersetzt_durch_nr"),
                rs.getObject("anlass_anstoss_id", UUID.class));
    }

    private static AnstossZeile anstoss(ResultSet rs, int i) throws SQLException {
        return new AnstossZeile(rs.getObject("id", UUID.class), rs.getObject("stand_id", UUID.class), rs.getInt("nr"),
                rs.getString("art"), rs.getString("anlass_kennung"), (Integer) rs.getObject("anlass_fassung"),
                zeit(rs, "erkannt_am"), rs.getString("zustand"), (Integer) rs.getObject("erledigt_durch_nr"),
                rs.getString("verworfen_begruendung"), rs.getString("verworfen_von_sub"), rs.getString("verworfen_von_name"),
                zeit(rs, "verworfen_am"));
    }

    private static Instant zeit(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
