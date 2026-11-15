package com.voltpilot.api.repo;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Logiken einer Anlage ({@code steuerlogik}), ihr Lauf auf der Box ({@code steuerlogik_lauf}), das
 * Vergleichsprotokoll ({@code steuerlogik_wechsel}), die gestellten Werte ({@code steuerlogik_einstellung}) und
 * was Menschen an einer Logik getan haben ({@code steuerlogik_protokoll}), alles unter RLS des aktuellen Mandanten
 * (V20261114180000__steuerlogik.sql, V20261114200000__steuerlogik_scharf.sql). Texte und Artefakt bleiben TEXT -
 * Byte für Byte, was kam und was der Dienst gebaut hat.
 */
@Repository
public class SteuerlogikRepository {

    private final JdbcTemplate jdbc;

    public SteuerlogikRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Eine Fassung einer Logik, ohne die großen Texte. Stufe 4: Rolle und Anzeigename des Urhebers, Notiz, wer sie wann
     * zur Freigabe vorgelegt hat.
     */
    public record Fassung(UUID logikId, int fassung, UUID siteId, String name, String zustand,
            String contentHash, String berichtJson, Instant angelegtAm, String angelegtVon, Instant stillgelegtAm,
            Instant scharfAm, String scharfVon, String hinweiseJson, String angelegtRolle, String angelegtName,
            String notiz, Instant vorgelegtAm, String vorgelegtVon, String vorgelegtName, String herkunft,
            UUID herkunftFlowId, Integer herkunftFassung, String herkunftStand, UUID herkunftGeraet) {

        public Fassung(UUID logikId, int fassung, UUID siteId, String name, String zustand, String contentHash,
                String berichtJson, Instant angelegtAm, String angelegtVon, Instant stillgelegtAm, Instant scharfAm,
                String scharfVon, String hinweiseJson) {
            this(logikId, fassung, siteId, name, zustand, contentHash, berichtJson, angelegtAm, angelegtVon,
                    stillgelegtAm, scharfAm, scharfVon, hinweiseJson, null, angelegtVon, null, null, null, null, null,
                    null, null, null, null);
        }

        /**
         * Stufe 6 (Zusammenführen): die Übersetzung einer Regel des Regel-Baukastens. Bearbeitet wird die Regel; die
         * Logik folgt ihr und ist im Aufbau und Text nur zu lesen.
         */
        public boolean ausRegel() {
            return HERKUNFT_REGEL.equals(herkunft);
        }

        /**
         * Stufe 6 (Zusammenführen): eine abgeleitete Logik - die Übersetzung einer Regel, einer Steuerart oder des
         * Heizstab-Reglers. Bearbeitet wird ihr Ursprung; sie ist im Aufbau und Text nur zu lesen.
         */
        public boolean abgeleitet() {
            return herkunft != null;
        }

        /** Stufe 6, dritter Teil: die Übersetzung einer Steuerart oder des Heizstab-Reglers (Gruppe der Geräte). */
        public boolean ausSteuerart() {
            return HERKUNFT_STEUERART.equals(herkunft) || HERKUNFT_HEIZSTAB.equals(herkunft);
        }

        public boolean aktiv() {
            return ZUSTAND_MITLAUFEND.equals(zustand) || ZUSTAND_SCHARF.equals(zustand);
        }

        public boolean scharf() {
            return ZUSTAND_SCHARF.equals(zustand);
        }
    }

    /** Die Herkunft einer abgeleiteten Logik (V20261115230000): die Übersetzung einer Regel. */
    public static final String HERKUNFT_REGEL = "regel";
    /** Die Übersetzung der Verbraucherregel einer Steuerart (V20261116000000). */
    public static final String HERKUNFT_STEUERART = "steuerart";
    /** Die Übersetzung des Heizstab-Reglers aus seinem Parameterblock (V20261116000000). */
    public static final String HERKUNFT_HEIZSTAB = "heizstab";

    /** Die Zustände einer Fassung (V20261114200000, V20261115190000). */
    public static final String ZUSTAND_GEPRUEFT = "geprueft";
    public static final String ZUSTAND_MITLAUFEND = "mitlaufend";
    public static final String ZUSTAND_SCHARF = "scharf";
    public static final String ZUSTAND_STILLGELEGT = "stillgelegt";

    /** Die gestellten Werte einer Logik: Stand und JSON-Objekt (Kennung -> Form des Dokuments). */
    public record Einstellung(long stand, String werteJson) {}

    /** Ein Eintrag des Protokolls; {@code vonName} ist der Anzeigename des Kontos, sonst die Kennung. */
    public record Schritt(UUID logikId, int fassung, String was, Instant am, String von, String vonName,
            String rolle, String datenJson) {}

    /** Ein Gerät einer scharfen Logik der Anlage. */
    public record Besitz(UUID entityId, UUID logikId, String name) {}

    /** Der jüngste gemeldete Mitlauf einer Logik auf einer Box. */
    public record Lauf(UUID deviceId, UUID logikId, int fassung, String contentHash, String zustand,
            Instant seit, String rueckmeldungJson, Instant gemeldetAm) {}

    /** Eine Zeile des Vergleichsprotokolls. */
    public record Wechsel(UUID deviceId, UUID logikId, int fassung, Instant laufSeit, long nr, Instant t,
            String geraet, String was, String neuJson, String andereJson, String lage) {}

    // --- Logiken ------------------------------------------------------------------------------------------------

    /** Die nächste Fassung einer Logik (1 für eine neue). */
    public int naechsteFassung(UUID logikId) {
        Integer max = jdbc.queryForObject("SELECT max(fassung) FROM steuerlogik WHERE logik_id = ?",
                Integer.class, logikId);
        return max == null ? 1 : max + 1;
    }

    /** Ob die Logik zu dieser Anlage gehört (unter RLS: eine fremde ist unsichtbar). */
    public boolean gehoertZu(UUID logikId, UUID siteId) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM steuerlogik WHERE logik_id = ? AND site_id = ?",
                Integer.class, logikId, siteId);
        return n != null && n > 0;
    }

    /**
     * Legt eine Fassung an und lässt sie mitlaufen; eine bis dahin mitlaufende Fassung derselben Logik wird
     * stillgelegt. In der Transaktion des Aufrufers.
     */
    public void legeAn(UUID tenantId, UUID siteId, UUID logikId, int fassung, String name, String quelltext,
            String kanonisch, String artefakt, String contentHash, String berichtJson, String von, Instant jetzt) {
        stillegen(logikId, jetzt);
        jdbc.update("""
                INSERT INTO steuerlogik (logik_id, fassung, tenant_id, site_id, name, quelltext, kanonisch, artefakt,
                                         content_hash, bericht, zustand, angelegt_am, angelegt_von)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, 'mitlaufend', ?, ?)
                """, logikId, fassung, tenantId, siteId, name, quelltext, kanonisch, artefakt, contentHash,
                berichtJson, Timestamp.from(jetzt), von);
    }

    /** Legt die aktive Fassung still (mitlaufend oder scharf); Zahl der betroffenen Zeilen. */
    public int stillegen(UUID logikId, Instant jetzt) {
        return jdbc.update("UPDATE steuerlogik SET zustand = 'stillgelegt', stillgelegt_am = ? "
                + "WHERE logik_id = ? AND zustand IN ('mitlaufend', 'scharf')", Timestamp.from(jetzt), logikId);
    }

    /** Der Anzeigename eines Kontos des Mandanten, sonst die Kennung (wie im Protokoll). */
    private static String anzeigename(String spalte) {
        return "COALESCE((SELECT NULLIF(btrim(b.anzeigename), '') FROM benutzer b WHERE b.tenant_id = s.tenant_id "
                + "AND b.sub = s." + spalte + "), s." + spalte + ")";
    }

    private static final String FASSUNG_SPALTEN = """
            s.logik_id, s.fassung, s.site_id, s.name, s.zustand, s.content_hash, s.bericht::text, s.angelegt_am,
            s.angelegt_von, s.stillgelegt_am, s.scharf_am, s.scharf_von, s.hinweise::text, s.angelegt_rolle,
            """ + anzeigename("angelegt_von") + ", s.notiz, s.vorgelegt_am, s.vorgelegt_von, "
            + anzeigename("vorgelegt_von") + ", s.herkunft, s.herkunft_flow_id, s.herkunft_fassung, "
            + "s.herkunft_stand, s.herkunft_geraet ";

    private static Fassung fassung(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new Fassung(rs.getObject(1, UUID.class), rs.getInt(2), rs.getObject(3, UUID.class), rs.getString(4),
                rs.getString(5), rs.getString(6), rs.getString(7), instant(rs.getTimestamp(8)), rs.getString(9),
                instant(rs.getTimestamp(10)), instant(rs.getTimestamp(11)), rs.getString(12), rs.getString(13),
                rs.getString(14), rs.getString(15), rs.getString(16), instant(rs.getTimestamp(17)), rs.getString(18),
                rs.getString(19), rs.getString(20), rs.getObject(21, UUID.class), (Integer) rs.getObject(22),
                rs.getString(23), rs.getObject(24, UUID.class));
    }

    /** Alle Fassungen der Anlage, je Logik die jüngste zuerst. */
    public List<Fassung> fassungen(UUID siteId) {
        return jdbc.query("SELECT " + FASSUNG_SPALTEN + " FROM steuerlogik s WHERE s.site_id = ? "
                + "ORDER BY s.angelegt_am DESC, s.logik_id, s.fassung DESC", (rs, i) -> fassung(rs), siteId);
    }

    /** Die aktive Fassung einer Logik (mitlaufend oder scharf), {@code null} ohne. */
    public Fassung aktiveFassung(UUID logikId) {
        List<Fassung> f = jdbc.query("SELECT " + FASSUNG_SPALTEN + " FROM steuerlogik s WHERE s.logik_id = ? "
                + "AND s.zustand IN ('mitlaufend', 'scharf')", (rs, i) -> fassung(rs), logikId);
        return f.isEmpty() ? null : f.get(0);
    }

    /** Eine bestimmte Fassung, {@code null}, wenn es sie nicht gibt. */
    public Fassung fassung(UUID logikId, int fassung) {
        List<Fassung> f = jdbc.query("SELECT " + FASSUNG_SPALTEN + " FROM steuerlogik s WHERE s.logik_id = ? "
                + "AND s.fassung = ?", (rs, i) -> fassung(rs), logikId, fassung);
        return f.isEmpty() ? null : f.get(0);
    }

    /** Die Fassung vor {@code fassung} (die höchste kleinere Nummer), {@code null} ohne. */
    public Fassung vorige(UUID logikId, int fassung) {
        List<Fassung> f = jdbc.query("SELECT " + FASSUNG_SPALTEN + " FROM steuerlogik s WHERE s.logik_id = ? "
                + "AND s.fassung < ? ORDER BY s.fassung DESC LIMIT 1", (rs, i) -> fassung(rs), logikId, fassung);
        return f.isEmpty() ? null : f.get(0);
    }

    /** Alle Fassungen einer Logik, die jüngste zuerst. */
    public List<Fassung> fassungenDerLogik(UUID logikId) {
        return jdbc.query("SELECT " + FASSUNG_SPALTEN + " FROM steuerlogik s WHERE s.logik_id = ? "
                + "ORDER BY s.fassung DESC", (rs, i) -> fassung(rs), logikId);
    }

    /** Die höchste Fassung einer Logik, 0 ohne. */
    public int neuesteFassung(UUID logikId) {
        Integer max = jdbc.queryForObject("SELECT max(fassung) FROM steuerlogik WHERE logik_id = ?",
                Integer.class, logikId);
        return max == null ? 0 : max;
    }

    /**
     * Speichert eine geprüfte Fassung, die noch nicht läuft (Stufe 4): mit Rolle des Urhebers und Notiz. In der
     * Transaktion des Aufrufers; die aktive Fassung bleibt, wie sie ist.
     */
    public void speichere(UUID tenantId, UUID siteId, UUID logikId, int fassung, String name, String quelltext,
            String kanonisch, String artefakt, String contentHash, String berichtJson, String von, String rolle,
            String notiz, Instant jetzt) {
        jdbc.update("""
                INSERT INTO steuerlogik (logik_id, fassung, tenant_id, site_id, name, quelltext, kanonisch, artefakt,
                                         content_hash, bericht, zustand, angelegt_am, angelegt_von, angelegt_rolle,
                                         notiz)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, 'geprueft', ?, ?, ?, ?)
                """, logikId, fassung, tenantId, siteId, name, quelltext, kanonisch, artefakt, contentHash,
                berichtJson, Timestamp.from(jetzt), von, rolle, notiz);
    }

    /** Hält fest, wer eine Fassung wann zur Freigabe vorgelegt hat. */
    public void legeVor(UUID logikId, int fassung, String von, Instant jetzt) {
        jdbc.update("UPDATE steuerlogik SET vorgelegt_am = ?, vorgelegt_von = ? WHERE logik_id = ? AND fassung = ?",
                Timestamp.from(jetzt), von, logikId, fassung);
    }

    // --- Anfragen (Stufe 4: "Änderung anfragen") ------------------------------------------------------------------

    /** Eine Anfrage an einer Logik; {@code vonName} ist der Anzeigename des Kontos, sonst die Kennung. */
    public record Anfrage(UUID id, UUID logikId, String kennung, String text, Instant am, String von, String vonName,
            String rolle, Instant erledigtAm, String erledigtVon, String erledigtName) {}

    public void frageAn(UUID tenantId, UUID siteId, UUID id, UUID logikId, String kennung, String text, String von,
            String rolle, Instant jetzt) {
        jdbc.update("""
                INSERT INTO steuerlogik_anfrage (id, tenant_id, site_id, logik_id, kennung, text, am, von, rolle)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, id, tenantId, siteId, logikId, kennung, text, Timestamp.from(jetzt), von, rolle);
    }

    /** Die Anfragen einer Logik, jüngste zuerst, höchstens {@code grenze}. */
    public List<Anfrage> anfragen(UUID logikId, int grenze) {
        return jdbc.query("SELECT s.id, s.logik_id, s.kennung, s.text, s.am, s.von, " + anzeigename("von")
                + ", s.rolle, s.erledigt_am, s.erledigt_von, " + anzeigename("erledigt_von")
                + " FROM steuerlogik_anfrage s WHERE s.logik_id = ? ORDER BY s.am DESC LIMIT ?",
                (rs, i) -> new Anfrage(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3),
                        rs.getString(4), instant(rs.getTimestamp(5)), rs.getString(6), rs.getString(7),
                        rs.getString(8), instant(rs.getTimestamp(9)), rs.getString(10), rs.getString(11)),
                logikId, grenze);
    }

    /** Je Logik der Anlage die Zahl der offenen Anfragen. */
    public java.util.Map<UUID, Integer> offeneAnfragen(UUID siteId) {
        java.util.Map<UUID, Integer> out = new java.util.HashMap<>();
        jdbc.query("SELECT logik_id, count(*) FROM steuerlogik_anfrage WHERE site_id = ? AND erledigt_am IS NULL "
                + "GROUP BY logik_id", rs -> {
                    out.put(rs.getObject(1, UUID.class), rs.getInt(2));
                }, siteId);
        return out;
    }

    /** Hakt eine offene Anfrage ab; {@code false}, wenn es sie an dieser Logik nicht (mehr offen) gibt. */
    public boolean erledige(UUID logikId, UUID id, String von, Instant jetzt) {
        return jdbc.update("UPDATE steuerlogik_anfrage SET erledigt_am = ?, erledigt_von = ? "
                + "WHERE id = ? AND logik_id = ? AND erledigt_am IS NULL", Timestamp.from(jetzt), von, id,
                logikId) > 0;
    }

    /**
     * Gibt einer Fassung ein neues Artefakt und einen Zustand (mitlaufend oder scharf). Beim Scharfschalten trägt sie
     * wer, wann und die Hinweise des Dialogs; eine zurückgeholte Fassung verliert ihr Stilllegungsdatum. In der
     * Transaktion des Aufrufers.
     */
    public void aktiviere(UUID logikId, int fassung, String zustand, String artefakt, String contentHash,
            Instant scharfAm, String scharfVon, String hinweiseJson) {
        jdbc.update("""
                UPDATE steuerlogik SET zustand = ?, artefakt = ?, content_hash = ?, stillgelegt_am = NULL,
                       scharf_am = COALESCE(?, scharf_am), scharf_von = COALESCE(?, scharf_von),
                       hinweise = COALESCE(?::jsonb, hinweise)
                WHERE logik_id = ? AND fassung = ?
                """, zustand, artefakt, contentHash, scharfAm == null ? null : Timestamp.from(scharfAm), scharfVon,
                hinweiseJson, logikId, fassung);
    }

    /** Das Artefakt einer Fassung, Byte für Byte wie gebaut; {@code null} ohne. */
    public String artefakt(UUID logikId, int fassung) {
        List<String> t = jdbc.queryForList("SELECT artefakt FROM steuerlogik WHERE logik_id = ? AND fassung = ?",
                String.class, logikId, fassung);
        return t.isEmpty() ? null : t.get(0);
    }

    /**
     * Die Geräte der scharfen Logiken der Anlage, aus dem gespeicherten Prüfbericht (der Dienst nennt sie dort; die
     * API liest die Sprache nicht). Ohne die Übersetzungen von Regeln (Stufe 6): deren Geräte gehören der Regel, und
     * die Regel beansprucht sie selbst ({@code flow_claim}, V-5).
     */
    public List<Besitz> scharfeGeraete(UUID siteId) {
        return jdbc.query("""
                SELECT (g->>'entity_id'), s.logik_id, s.name
                FROM steuerlogik s, jsonb_array_elements(COALESCE(s.bericht->'geraete', '[]'::jsonb)) g
                WHERE s.site_id = ? AND s.zustand = 'scharf' AND s.herkunft IS NULL
                """, (rs, i) -> {
                    UUID entity;
                    try {
                        entity = UUID.fromString(rs.getString(1));
                    } catch (IllegalArgumentException | NullPointerException e) {
                        entity = null;
                    }
                    return new Besitz(entity, rs.getObject(2, UUID.class), rs.getString(3));
                }, siteId).stream().filter(b -> b.entityId() != null).toList();
    }

    // --- Gestellte Werte und Protokoll --------------------------------------------------------------------------

    /** Die gestellten Werte einer Logik; ohne Zeile Stand 0 und keine Werte. */
    public Einstellung einstellung(UUID logikId) {
        List<Einstellung> e = jdbc.query("SELECT stand, werte FROM steuerlogik_einstellung WHERE logik_id = ?",
                (rs, i) -> new Einstellung(rs.getLong(1), rs.getString(2)), logikId);
        return e.isEmpty() ? new Einstellung(0, "{}") : e.get(0);
    }

    /** Schreibt die gestellten Werte einer Logik mit ihrem Stand. In der Transaktion des Aufrufers. */
    public void setzeEinstellung(UUID tenantId, UUID siteId, UUID logikId, long stand, String werteJson,
            Instant jetzt) {
        jdbc.update("""
                INSERT INTO steuerlogik_einstellung (logik_id, tenant_id, site_id, stand, werte, geaendert_am)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (logik_id) DO UPDATE SET stand = EXCLUDED.stand, werte = EXCLUDED.werte,
                    geaendert_am = EXCLUDED.geaendert_am
                """, logikId, tenantId, siteId, stand, werteJson, Timestamp.from(jetzt));
    }

    /**
     * Schreibt die gestellten Werte nur, wenn der Stand noch {@code alt} ist (optimistisch: zwei gleichzeitige
     * Änderungen dürfen einander nicht still überschreiben). {@code false} = jemand war schneller.
     */
    public boolean setzeEinstellungWennStand(UUID tenantId, UUID siteId, UUID logikId, long alt, long neu,
            String werteJson, Instant jetzt) {
        if (alt == 0) {
            // Noch nie gestellt: die erste Zeile legt an; kam eine gleichzeitige zuerst, ist ihr Stand nicht mehr 0.
            return jdbc.update("""
                    INSERT INTO steuerlogik_einstellung (logik_id, tenant_id, site_id, stand, werte, geaendert_am)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT (logik_id) DO UPDATE SET stand = EXCLUDED.stand, werte = EXCLUDED.werte,
                        geaendert_am = EXCLUDED.geaendert_am
                    WHERE steuerlogik_einstellung.stand = 0
                    """, logikId, tenantId, siteId, neu, werteJson, Timestamp.from(jetzt)) > 0;
        }
        return jdbc.update("UPDATE steuerlogik_einstellung SET stand = ?, werte = ?, geaendert_am = ? "
                + "WHERE logik_id = ? AND stand = ?", neu, werteJson, Timestamp.from(jetzt), logikId, alt) > 0;
    }

    /** Hält einen Schritt im Protokoll fest. In der Transaktion des Aufrufers. */
    public void protokolliere(UUID tenantId, UUID siteId, UUID logikId, int fassung, String was, String von,
            String rolle, String datenJson, Instant jetzt) {
        jdbc.update("""
                INSERT INTO steuerlogik_protokoll (id, tenant_id, site_id, logik_id, fassung, was, am, von, rolle, daten)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
                """, UUID.randomUUID(), tenantId, siteId, logikId, fassung, was, Timestamp.from(jetzt), von, rolle,
                datenJson);
    }

    /** Das Protokoll einer Logik in einem Zeitraum (halboffen), jüngstes zuerst, höchstens {@code grenze} Einträge. */
    public List<Schritt> protokoll(UUID logikId, Instant von, Instant bis, int grenze) {
        return jdbc.query("""
                SELECT p.logik_id, p.fassung, p.was, p.am, p.von,
                       COALESCE((SELECT NULLIF(btrim(b.anzeigename), '') FROM benutzer b
                                 WHERE b.tenant_id = p.tenant_id AND b.sub = p.von), p.von),
                       p.rolle, p.daten::text
                FROM steuerlogik_protokoll p WHERE p.logik_id = ? AND p.am >= ? AND p.am < ?
                ORDER BY p.am DESC LIMIT ?
                """, (rs, i) -> new Schritt(rs.getObject(1, UUID.class), rs.getInt(2), rs.getString(3),
                instant(rs.getTimestamp(4)), rs.getString(5), rs.getString(6), rs.getString(7), rs.getString(8)),
                logikId, Timestamp.from(von), Timestamp.from(bis), grenze);
    }

    /** Der Quelltext einer Fassung, wie er kam ({@code null}, wenn es sie nicht gibt). */
    public String quelltext(UUID logikId, int fassung) {
        List<String> t = jdbc.queryForList("SELECT quelltext FROM steuerlogik WHERE logik_id = ? AND fassung = ?",
                String.class, logikId, fassung);
        return t.isEmpty() ? null : t.get(0);
    }

    /**
     * Ein auszulieferndes Artefakt mit dem Zustand seiner Fassung; {@code ausRegel}: die Übersetzung einer Regel,
     * {@code ausSteuerart}: die einer Steuerart oder des Heizstab-Reglers.
     */
    public record Auslieferung(String artefakt, boolean scharf, boolean ausRegel, boolean ausSteuerart,
            String herkunft, UUID herkunftFlowId, UUID herkunftGeraet) {}

    /** Die Artefakte der aktiven Logiken der Anlage (mitlaufend und scharf), Byte für Byte wie gebaut. */
    public List<Auslieferung> aktiveArtefakte(UUID siteId) {
        return jdbc.query("SELECT artefakt, zustand, herkunft, herkunft_flow_id, herkunft_geraet FROM steuerlogik "
                + "WHERE site_id = ? AND zustand IN ('mitlaufend', 'scharf') ORDER BY angelegt_am, logik_id",
                (rs, i) -> new Auslieferung(rs.getString(1), ZUSTAND_SCHARF.equals(rs.getString(2)),
                        HERKUNFT_REGEL.equals(rs.getString(3)), HERKUNFT_STEUERART.equals(rs.getString(3))
                                || HERKUNFT_HEIZSTAB.equals(rs.getString(3)), rs.getString(3),
                        rs.getObject(4, UUID.class), rs.getObject(5, UUID.class)), siteId);
    }

    // --- Übersetzte Regeln (Stufe 6, Zusammenführen) --------------------------------------------------------------

    /**
     * Legt die Übersetzung einer Regel als neue Fassung ihrer abgeleiteten Logik an, mitlaufend oder scharf; die bis
     * dahin aktive Fassung wird stillgelegt. In der Transaktion des Aufrufers.
     */
    public void legeRegelAn(UUID tenantId, UUID siteId, UUID logikId, int fassung, String name, String quelltext,
            String kanonisch, String artefakt, String contentHash, String berichtJson, String zustand, UUID flowId,
            int flowFassung, String von, String rolle, Instant jetzt) {
        stillegen(logikId, jetzt);
        jdbc.update("""
                INSERT INTO steuerlogik (logik_id, fassung, tenant_id, site_id, name, quelltext, kanonisch, artefakt,
                                         content_hash, bericht, zustand, angelegt_am, angelegt_von, angelegt_rolle,
                                         scharf_am, scharf_von, herkunft, herkunft_flow_id, herkunft_fassung)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, 'regel', ?, ?)
                """, logikId, fassung, tenantId, siteId, name, quelltext, kanonisch, artefakt, contentHash,
                berichtJson, zustand, Timestamp.from(jetzt), von, rolle,
                ZUSTAND_SCHARF.equals(zustand) ? Timestamp.from(jetzt) : null,
                ZUSTAND_SCHARF.equals(zustand) ? von : null, flowId, flowFassung);
    }

    /**
     * Legt die Übersetzung einer Steuerart oder des Heizstab-Reglers als neue Fassung ihrer abgeleiteten Logik an
     * (Stufe 6, dritter Teil): {@code quelle} ist der generierte Flow (Steuerart) oder das Gerät (Heizstab),
     * {@code stand} der Fingerabdruck dessen, woraus sie entstand, {@code geraet} das Gerät, dessen alten Weg sie
     * ersetzt. Die bis dahin aktive Fassung wird stillgelegt. In der Transaktion des Aufrufers.
     */
    public void legeGeraetAn(UUID tenantId, UUID siteId, UUID logikId, int fassung, String name, String quelltext,
            String kanonisch, String artefakt, String contentHash, String berichtJson, String zustand, String herkunft,
            UUID quelle, Integer quelleFassung, String stand, UUID geraet, Instant jetzt) {
        stillegen(logikId, jetzt);
        jdbc.update("""
                INSERT INTO steuerlogik (logik_id, fassung, tenant_id, site_id, name, quelltext, kanonisch, artefakt,
                                         content_hash, bericht, zustand, angelegt_am, scharf_am, herkunft,
                                         herkunft_flow_id, herkunft_fassung, herkunft_stand, herkunft_geraet)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?)
                """, logikId, fassung, tenantId, siteId, name, quelltext, kanonisch, artefakt, contentHash,
                berichtJson, zustand, Timestamp.from(jetzt),
                ZUSTAND_SCHARF.equals(zustand) ? Timestamp.from(jetzt) : null, herkunft, quelle, quelleFassung,
                stand, geraet);
    }

    /** Die aktiven Übersetzungen der Steuerarten und Heizstab-Regler einer Anlage (mitlaufend oder scharf). */
    public List<Fassung> aktiveGeraete(UUID siteId) {
        return jdbc.query("SELECT " + FASSUNG_SPALTEN + " FROM steuerlogik s WHERE s.site_id = ? "
                + "AND s.herkunft IN ('steuerart', 'heizstab') AND s.zustand IN ('mitlaufend', 'scharf') "
                + "ORDER BY s.angelegt_am", (rs, i) -> fassung(rs), siteId);
    }

    /** Die aktiven Übersetzungen der Regeln einer Anlage (mitlaufend oder scharf), je Regel höchstens eine. */
    public List<Fassung> aktiveRegeln(UUID siteId) {
        return jdbc.query("SELECT " + FASSUNG_SPALTEN + " FROM steuerlogik s WHERE s.site_id = ? "
                + "AND s.herkunft = 'regel' AND s.zustand IN ('mitlaufend', 'scharf') ORDER BY s.angelegt_am",
                (rs, i) -> fassung(rs), siteId);
    }

    // --- Mitlauf aus dem Herzschlag ------------------------------------------------------------------------------

    /**
     * Ersetzt den Mitlauf einer Box: Logiken, die sie nicht mehr meldet, fallen weg; gemeldete werden geschrieben.
     */
    public void ersetzeLaeufe(UUID deviceId, UUID tenantId, UUID siteId, List<Lauf> laeufe, Instant gemeldet) {
        if (laeufe.isEmpty()) {
            jdbc.update("DELETE FROM steuerlogik_lauf WHERE device_id = ?", deviceId);
            return;
        }
        UUID[] ids = laeufe.stream().map(Lauf::logikId).toArray(UUID[]::new);
        jdbc.update(con -> {
            var ps = con.prepareStatement("DELETE FROM steuerlogik_lauf WHERE device_id = ? AND NOT (logik_id = ANY (?))");
            ps.setObject(1, deviceId);
            ps.setArray(2, con.createArrayOf("uuid", ids));
            return ps;
        });
        for (Lauf l : laeufe) {
            jdbc.update("""
                    INSERT INTO steuerlogik_lauf (device_id, logik_id, tenant_id, site_id, fassung, content_hash, zustand,
                                                  seit, rueckmeldung, gemeldet_am)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)
                    ON CONFLICT (device_id, logik_id) DO UPDATE SET site_id = EXCLUDED.site_id,
                        fassung = EXCLUDED.fassung, content_hash = EXCLUDED.content_hash, zustand = EXCLUDED.zustand,
                        seit = EXCLUDED.seit, rueckmeldung = EXCLUDED.rueckmeldung, gemeldet_am = EXCLUDED.gemeldet_am
                    """, deviceId, l.logikId(), tenantId, siteId, l.fassung(), l.contentHash(), l.zustand(),
                    Timestamp.from(l.seit()), l.rueckmeldungJson(), Timestamp.from(gemeldet));
        }
    }

    /** Schreibt Zeilen des Vergleichsprotokolls; eine schon bekannte (Lauf und Nummer) bleibt, wie sie ist. */
    public void schreibeWechsel(UUID tenantId, UUID siteId, List<Wechsel> zeilen) {
        for (Wechsel w : zeilen) {
            jdbc.update("""
                    INSERT INTO steuerlogik_wechsel (device_id, logik_id, lauf_seit, nr, tenant_id, site_id, fassung, t,
                                                     geraet, was, neu, andere, lage)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?)
                    ON CONFLICT (device_id, logik_id, lauf_seit, nr) DO NOTHING
                    """, w.deviceId(), w.logikId(), Timestamp.from(w.laufSeit()), w.nr(), tenantId, siteId,
                    w.fassung(), Timestamp.from(w.t()), w.geraet(), w.was(), w.neuJson(), w.andereJson(), w.lage());
        }
    }

    /** Hält das Protokoll einer Box kurz: Zeilen vor {@code vor} fallen weg. */
    public int raeumeWechsel(UUID deviceId, Instant vor) {
        return jdbc.update("DELETE FROM steuerlogik_wechsel WHERE device_id = ? AND t < ?", deviceId,
                Timestamp.from(vor));
    }

    /** Der gemeldete Mitlauf der Anlage. */
    public List<Lauf> laeufe(UUID siteId) {
        return jdbc.query("""
                SELECT device_id, logik_id, fassung, content_hash, zustand, seit, rueckmeldung::text, gemeldet_am
                FROM steuerlogik_lauf WHERE site_id = ? ORDER BY logik_id, device_id
                """, (rs, i) -> new Lauf(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getInt(3),
                rs.getString(4), rs.getString(5), instant(rs.getTimestamp(6)), rs.getString(7),
                instant(rs.getTimestamp(8))), siteId);
    }

    /** Das Protokoll einer Logik in einem Zeitraum (halboffen), älteste zuerst, höchstens {@code grenze} Zeilen. */
    public List<Wechsel> wechsel(UUID siteId, UUID logikId, Instant von, Instant bis, int grenze) {
        return jdbc.query("""
                SELECT device_id, logik_id, fassung, lauf_seit, nr, t, geraet, was, neu::text, andere::text, lage
                FROM steuerlogik_wechsel WHERE site_id = ? AND logik_id = ? AND t >= ? AND t < ?
                ORDER BY t, lauf_seit, nr LIMIT ?
                """, (rs, i) -> new Wechsel(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getInt(3),
                instant(rs.getTimestamp(4)), rs.getLong(5), instant(rs.getTimestamp(6)), rs.getString(7),
                rs.getString(8), rs.getString(9), rs.getString(10), rs.getString(11)),
                siteId, logikId, Timestamp.from(von), Timestamp.from(bis), grenze);
    }

    private static Instant instant(Timestamp ts) {
        return ts == null ? null : ts.toInstant();
    }
}
