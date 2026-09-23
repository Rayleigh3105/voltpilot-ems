package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.uems.EreignisVokabular.Urheber;
import com.voltpilot.api.uems.EreignisVokabular.Urteil;
import com.voltpilot.api.uems.KaskadeStufen.Abgelehnt;
import com.voltpilot.api.uems.KaskadeStufen.Gebildet;
import com.voltpilot.api.uems.KaskadeStufen.Gespeichert;
import com.voltpilot.api.uems.KaskadeStufen.Inhalt;
import com.voltpilot.api.uems.KaskadeStufen.Periode;
import com.voltpilot.api.uems.KaskadeStufen.ViertelVersion;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Savepoint;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Die KORREKTUR-KASKADE (UEMS AP-08 IP-17, Entscheid E9 = A): eine freigegebene Korrektur zieht automatisch bis zum
 * Jahr durch — ein freigegebener Bericht aber nie.
 *
 * <p><b>Die Freigabe ist nicht automatisch, die Kaskade schon.</b> Der Mensch entscheidet EINMAL, ob korrigiert wird
 * ({@code messreihe_korrektur}, Fassung {@code freigegeben}, E14 — die Route ist IP-15/IP-16). Was danach folgt, ist
 * Rechnen und wird nicht noch einmal bestätigt: die Viertelstunden der Korrektur, alle Tage, Monate und Jahre der
 * betroffenen Reihe, die berechneten Messstellen (AP-10, an {@link BerechnetePeriodenLauf#nachKorrektur}) und die
 * Kennzahlen ({@link KennzahlenNaht}, AP-11) — jede Stufe, die sich ändert, als Version n + 1 mit „korrigiert (Version
 * n)“ ({@link ErgebnisZustand#korrigiert}, ergebnis-zustand 1.5). Dieselbe Kaskade folgt einem Ersatzwert, sobald der
 * Ersatzwert-Lauf seine Viertelstunden gebildet hat (E7, F11/F21). Wessen Bilanz-Werte sich dadurch geändert haben —
 * berechnete Versionen und verteilte Werte der Kostenstellen-Sicht —, meldet {@link BilanzNeuBerechnet} in derselben
 * Transaktion als {@code bilanz_neu_berechnet} (AP-10 IP-11).
 *
 * <p><b>Die Grenze.</b> Ein freigegebener Bericht wird NIE geändert; er bekommt nur den Revisions-Auslöser, die Meldung
 * {@code correction} ({@link #berichteBenachrichtigen}). Ein Bericht-Entwurf bildet sich neu.
 *
 * <p><b>Rücknahme.</b> Die Gegenrichtung: die Viertelstunden der Korrektur bekommen den Stand VOR ihr als nächste Version
 * (§4.6 „Zustand wie vor der Korrektur“) — nur dort, wo keine spätere Entscheidung sie schon überschrieben hat — und jede
 * Stufe darüber wird aus diesem Stand neu gebildet. Keine Stufe trägt danach eine Zahl, die es in ihren Teilen nicht
 * mehr gibt.
 *
 * <p><b>Wiederholbar und abbruchsicher.</b> Arbeit ist jede Fassung eines Anlasses, die weiter ist als seine Wirkung
 * ({@code messreihe_kaskade_wirkung}). Ein Anlass wird in EINER Transaktion verarbeitet — Viertelstunden, Tage, Monate,
 * Jahre, berechnete Messstellen, Meldungen, Nähte und Wirkung zusammen: bricht irgendetwas ab, trägt keine Stufe eine
 * neue Version. Eine benannte Ablehnung rollt alles zurück und schreibt nur die Wirkung. Ein zweiter Lauf ohne neue
 * Fassung schreibt nichts.
 *
 * <p><b>Vorläufige Perioden ziehen nach.</b> Ein laufender Monat, ein laufendes Jahr bekommt nach einer Korrektur seine
 * Version — und entwickelt sich danach weiter wie Version 1. Der Nachzug ({@link #lauf}, zweiter Teil) bildet die
 * neueste Version einer noch vorläufigen Periode neu, sobald ihre Version 1 neu gebildet wurde, unter derselben Nummer;
 * eine endgültige Version bleibt, wie sie ist.
 */
@Component
public class KorrekturKaskade {

    private static final Logger log = LoggerFactory.getLogger(KorrekturKaskade.class);
    private static final ObjectMapper JSON = new ObjectMapper();

    // ------------------------------------------------------------------ die Wörter (messreihe_kaskade_woerter)

    public static final String GEBILDET = "gebildet";
    public static final String OHNE_WIRKUNG = "ohne_wirkung";
    /** Die Korrektur trägt keine Vorschau je Viertelstunde, die einer Reihe gehört (IP-14 schaut EINE Reihe vor). */
    public static final String VORSCHAU_FEHLT = "vorschau_fehlt";
    /** Die Rohwerte sagen heute etwas anderes als die freigegebene Vorschau — neue Werte sind ein neuer Vorschlag. */
    public static final String VORSCHAU_VERALTET = "vorschau_veraltet";
    /** Die Vorschau hat Werte, die Rohwerte dahinter sind nicht mehr da (90 Tage). */
    public static final String ROHWERTE_FEHLEN = "rohwerte_fehlen";
    /** Auf einer Viertelstunde der Korrektur wirkt ein Ersatzwert — sie zu überschreiben, löschte ihn still. */
    public static final String UEBERSCHNEIDET_ERSATZWERT = "ueberschneidet_ersatzwert";
    /** Ein Ablesestand (d) oder e–g über einer gröberen Periode: der Vertrag hat dafür keine Regel. */
    public static final String ERSATZWERT_OHNE_PERIODENREGEL = "ersatzwert_ohne_periodenregel";

    /** Das geschlossene Vokabular, Zeile für Zeile {@code messreihe_kaskade_woerter()}. */
    public static final List<String> WOERTER = List.of(GEBILDET, OHNE_WIRKUNG, VORSCHAU_FEHLT, VORSCHAU_VERALTET,
            ROHWERTE_FEHLEN, UEBERSCHNEIDET_ERSATZWERT, ERSATZWERT_OHNE_PERIODENREGEL);

    static final String FREIGEGEBEN = "freigegeben";
    static final String ZURUECKGENOMMEN = "zurueckgenommen";
    static final String WIRKSAM = "wirksam";
    /** AP-11 IP-9: die Berechnung einer Kennzahl gilt rückwirkend in einer neuen Fassung — Anlass ihr Kennzeichen. */
    static final String BERECHNUNG_GEAENDERT = "berechnung_geaendert";
    /** AP-11 IP-9: ein Stammdatum wurde rückwirkend eingetragen — Anlass das Kennzeichen der Bezugsgröße. */
    static final String STAMMDATUM_EINGETRAGEN = "stammdatum_eingetragen";
    /**
     * Die BEZUGSFLÄCHE eines Orts wurde rückwirkend geändert ({@code ort_aenderung} / {@code flaeche_geaendert}) —
     * Anlass das Kurzzeichen des Orts. AP-11 IP-9 hat diesen Auslöser nicht gebaut, weil eine Fläche damals kein
     * Kennzahl-Nenner sein konnte; seit dem Leseweg in die Ortsstruktur läuft er nicht mehr ins Leere.
     */
    static final String FLAECHE_GEAENDERT = "flaeche_geaendert";

    private static final String ART_NACHLIEFERUNG = "nachlieferung_nach_endgueltigkeit";
    private static final String ART_ABLESESTAENDE = "ablesestaende_nachgetragen";
    private static final String ART_UMKLASSIFIZIERUNG = "umklassifizierung";
    private static final String ART_ERSATZWERT = "ersatzwert";

    /** Wie viele Kandidaten eine Suche nach Arbeit ansieht (gesperrte Kundenbereiche werden übersprungen). */
    private static final int KANDIDATEN = 20;
    /** Wie viele vorläufige Versionen ein Lauf höchstens nachzieht. */
    private static final int NACHZUG_JE_LAUF = 200;

    // ------------------------------------------------------------------ was die Nähte bekommen

    public record Reihe(UUID entity, String kanal) {}

    /**
     * Eine Bezugsgröße, deren Wert sich für die Tage {@code periodeVon … periodeBis} (einschließlich) geändert hat (AP-11
     * IP-9, W1): eine wirksame Fassung ≥ 2 oder eine Rücknahme ({@code correction} mit Bezug {@code bezugsgroesse}), oder
     * ein rückwirkend eingetragenes Stammdatum ab {@code periodeVon}.
     *
     * @param kennzeichen das heutige Kennzeichen
     * @param fassung die neue Fassung des Werts ({@code fassung_neu}) bzw. der wievielte Stammdatum-Eintrag
     * @param status {@code freigegeben} · {@code zurueckgenommen} · {@code stammdatum_eingetragen}
     */
    public record Bezugsgroesse(UUID id, String kennzeichen, LocalDate periodeVon, LocalDate periodeBis, int fassung,
            String status) {}

    /**
     * Was eine Verarbeitung berührt hat — für die Kennzahlen (AP-11) und die Berichte (AP-12).
     *
     * @param anlass die Kennung des Vorgangs ({@code K-…}, {@code EW-…}, {@code BK-…}) — oder das Kennzeichen der Kennzahl
     *     ({@code berechnung_geaendert}) bzw. der Bezugsgröße ({@code stammdatum_eingetragen})
     * @param status {@code freigegeben} · {@code zurueckgenommen} (Korrektur, Berichtigung eines Bezugsgrößen-Werts) oder
     *     {@code wirksam} · {@code zurueckgenommen} (Ersatzwert); seit AP-11 IP-9 auch {@code berechnung_geaendert}
     *     (rückwirkende Fassung der Berechnung einer Kennzahl) und {@code stammdatum_eingetragen} (rückwirkendes Stammdatum)
     * @param ersterTag erster betroffener Tag in {@code zone}, {@code letzterTag} einschließlich
     * @param messstellen die berechneten Messstellen, die eine neue Version bekamen
     * @param ereignisse die Meldungen {@code correction} dieser Verarbeitung — DER Revisions-Auslöser
     * @param versionen wie viele Versionen (alle Stufen) geschrieben wurden
     * @param jetzt der Zeitpunkt des Laufs — dieselbe Uhr wie die Stufen (AP-11 IP-8: „läuft die Periode noch?“, und
     *     {@code berechnet_am} der neuen Kennzahl-Versionen); {@code null} nur ohne Lauf (Vertragsvektoren der Berichte)
     * @param bezugsgroessen die Bezugsgrößen, deren Wert sich geändert hat (AP-11 IP-9) — leer im Messreihen-Pfad
     */
    public record Betroffen(UUID tenant, String anlass, int fassung, String status, List<Reihe> reihen, Instant von,
            Instant bis, ZoneId zone, LocalDate ersterTag, LocalDate letzterTag, List<String> messstellen,
            List<UUID> ereignisse, int versionen, Instant jetzt, List<Bezugsgroesse> bezugsgroessen) {

        /** Der Messreihen-Pfad (AP-08 IP-17, AP-11 IP-8): keine Bezugsgröße. */
        public Betroffen(UUID tenant, String anlass, int fassung, String status, List<Reihe> reihen, Instant von,
                Instant bis, ZoneId zone, LocalDate ersterTag, LocalDate letzterTag, List<String> messstellen,
                List<UUID> ereignisse, int versionen, Instant jetzt) {
            this(tenant, anlass, fassung, status, reihen, von, bis, zone, ersterTag, letzterTag, messstellen, ereignisse,
                    versionen, jetzt, List.of());
        }

        /** Ohne Lauf — was die Vertragsvektoren der Berichte beschreiben (kein Zeitpunkt). */
        public Betroffen(UUID tenant, String anlass, int fassung, String status, List<Reihe> reihen, Instant von,
                Instant bis, ZoneId zone, LocalDate ersterTag, LocalDate letzterTag, List<String> messstellen,
                List<UUID> ereignisse, int versionen) {
            this(tenant, anlass, fassung, status, reihen, von, bis, zone, ersterTag, letzterTag, messstellen, ereignisse,
                    versionen, null);
        }
    }

    /** Was ein Lauf tat. */
    public record Lauf(int anlaesse, int versionen, int nachgezogen, Map<String, String> abgelehnt,
            List<BerechnetePeriode.Abgelehnt> kreise) {}

    private enum Modus {
        ANLASS,
        NACHZUG
    }

    private final JdbcTemplate adminJdbc;
    private final ViertelstundeVerdichter verdichter;
    private final BerechnetePeriodenLauf berechnete;
    private final KennzahlenNaht kennzahlen;
    private final BerichteNaht berichte;
    private final KaskadeStufen stufen;
    private final int anlaesseJeLauf;

    public KorrekturKaskade(
            @Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            MeasurementCatalog katalog,
            ViertelstundeVerdichter verdichter,
            ErsatzwertLauf ersatzwerte,
            BerechnetePeriodenLauf berechnete,
            KennzahlenNaht kennzahlen,
            BerichteNaht berichte,
            @Value("${voltpilot.uems.kaskade.je-lauf:50}") int anlaesseJeLauf) {
        this.adminJdbc = adminJdbc;
        this.verdichter = verdichter;
        this.berechnete = berechnete;
        this.kennzahlen = kennzahlen;
        this.berichte = berichte;
        this.stufen = new KaskadeStufen(katalog, ersatzwerte);
        this.anlaesseJeLauf = anlaesseJeLauf;
    }

    // ============================================================================ Der Lauf

    /** Ein Ergebnis EINER Transaktion — gezählt wird erst nach dem Commit. */
    private record Zug(int anlaesse, int versionen, int nachgezogen, Map<String, String> abgelehnt,
            List<BerechnetePeriode.Abgelehnt> kreise) {

        static final Zug NICHTS = new Zug(0, 0, 0, Map.of(), List.of());
    }

    public Lauf lauf(Instant jetzt) {
        int anlaesse = 0;
        int versionen = 0;
        int nachgezogen = 0;
        Map<String, String> abgelehnt = new LinkedHashMap<>();
        List<BerechnetePeriode.Abgelehnt> kreise = new ArrayList<>();
        for (int i = 0; i < anlaesseJeLauf; i++) {
            Zug z = inTransaktion(con -> einen(con, jetzt));
            if (z == null) {
                break;
            }
            anlaesse += z.anlaesse();
            versionen += z.versionen();
            abgelehnt.putAll(z.abgelehnt());
            z.kreise().stream().filter(k -> !kreise.contains(k)).forEach(kreise::add);
        }
        for (int i = 0; i < NACHZUG_JE_LAUF; i++) {
            Zug z = inTransaktion(con -> nachziehen(con, jetzt));
            if (z == null) {
                break;
            }
            nachgezogen += z.nachgezogen();
            z.kreise().stream().filter(k -> !kreise.contains(k)).forEach(kreise::add);
        }
        if (anlaesse > 0 || nachgezogen > 0) {
            log.info("UEMS Korrektur-Kaskade: {} Anlässe, {} Versionen, {} nachgezogen, {} abgelehnt", anlaesse,
                    versionen, nachgezogen, abgelehnt.size());
        }
        return new Lauf(anlaesse, versionen, nachgezogen, Map.copyOf(abgelehnt), List.copyOf(kreise));
    }

    /**
     * Woher ein Anlass kommt. Korrektur und Ersatzwert gehen durch die Stufen der Messreihe; die Auslöser aus AP-11 IP-9
     * berühren keine Messreihe und rufen nur die Kennzahl- und die Berichts-Naht ({@link #ohneStufen}).
     */
    private enum Quelle {
        KORREKTUR, ERSATZWERT, BEZUGSGROESSE, DEFINITION, STAMMDATUM, FLAECHE;

        boolean ohneStufen() {
            return this != KORREKTUR && this != ERSATZWERT;
        }

        /**
         * Ob die Berichts-Naht diesen Anlass sehen soll. Eine rückwirkend geänderte FLÄCHE liest AP-12 IP-9 schon
         * selbst ({@code StrukturAenderungLaeufer} über {@code ort_aenderung}, eigenes Wasserzeichen) — ein zweiter
         * Anstoß desselben Vorgangs wäre eine zweite Revision für dieselbe Tatsache.
         */
        boolean anBerichte() {
            return this != FLAECHE;
        }
    }

    /**
     * Ein Anlass: seine Kennung in {@code messreihe_kaskade_wirkung}, die Fassung, die weiter ist als seine Wirkung, der
     * Status; {@code objekt} = die Kennzahl ({@link Quelle#DEFINITION}) bzw. die Bezugsgröße ({@link Quelle#STAMMDATUM}).
     */
    private record Anlass(UUID tenant, String kennung, Quelle quelle, int fassung, String status, UUID objekt) {

        boolean korrektur() {
            return quelle == Quelle.KORREKTUR;
        }
    }

    /** Einen Anlass verarbeiten — {@code null}, wenn es keine Arbeit gibt. */
    private Zug einen(Connection con, Instant jetzt) throws SQLException {
        for (Anlass a : kandidaten(con)) {
            if (!sperre(con, "uems-kaskade:" + a.tenant(), false)) {
                continue;
            }
            // Unter der Sperre noch einmal: ein gleichzeitiger Lauf kann ihn eben verarbeitet haben.
            if (wirkungFassung(con, a.tenant(), a.kennung()) >= a.fassung()) {
                return Zug.NICHTS;
            }
            Savepoint sp = con.setSavepoint();
            try {
                Verarbeitet v = a.quelle().ohneStufen() ? ohneStufen(con, a, jetzt) : verarbeiten(con, a, jetzt);
                wirkung(con, a, v.versionen() > 0 ? GEBILDET : OHNE_WIRKUNG, v.versionen(), jetzt);
                return new Zug(1, v.versionen(), 0, Map.of(), v.kreise());
            } catch (Abgelehnt ab) {
                con.rollback(sp);
                log.warn("UEMS Korrektur-Kaskade: {} {} (Fassung {}) abgelehnt: {}", a.kennung(), a.status(), a.fassung(),
                        ab.getMessage());
                wirkung(con, a, ab.grund(), 0, jetzt);
                return new Zug(1, 0, 0, Map.of(a.kennung(), ab.grund()), List.of());
            }
        }
        return null;
    }

    /**
     * Die Anlässe: Korrekturen, deren neueste Fassung eine Freigabe oder Rücknahme ist, und Ersatzwerte, deren neueste
     * Fassung der Ersatzwert-Lauf schon gerechnet hat; seit AP-11 IP-9 die Meldungen {@code correction} mit Bezug
     * {@code bezugsgroesse} (Kennung {@code BK-…}, Fassung = {@code fassung_neu}), rückwirkende Fassungen der Berechnung
     * einer Kennzahl ({@code kennzahl_fassung:<ID>}, Fassung = Nummer) und rückwirkend eingetragene Stammdaten
     * ({@code bezugsgroesse_stammdatum:<ID>}, Fassung = der wievielte Eintrag) — jeweils weiter als ihre Wirkung, älteste
     * zuerst.
     */
    private static List<Anlass> kandidaten(Connection con) throws SQLException {
        List<Anlass> aus = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT tenant_id, kennung, quelle, fassung, status, objekt FROM (
                    SELECT n.tenant_id, n.kennung, 'KORREKTUR' AS quelle, n.fassung, n.status, NULL::uuid AS objekt,
                           n.created_at
                      FROM (SELECT DISTINCT ON (tenant_id, kennung) tenant_id, kennung, fassung, status, created_at
                              FROM messreihe_korrektur ORDER BY tenant_id, kennung, fassung DESC) n
                      LEFT JOIN messreihe_kaskade_wirkung w ON w.tenant_id = n.tenant_id AND w.anlass_kennung = n.kennung
                     WHERE n.status IN ('freigegeben', 'zurueckgenommen') AND n.fassung > coalesce(w.fassung, 0)
                       AND NOT EXISTS (
                           SELECT 1 FROM messreihe_korrektur k
                            WHERE k.tenant_id = n.tenant_id AND k.kennung = n.kennung AND k.fassung = 1
                              AND k.ersatzwert_kennung IS NOT NULL AND NOT EXISTS (
                                  SELECT 1 FROM messreihe_ersatzwert_wirkung ew
                                   WHERE ew.tenant_id = k.tenant_id AND ew.kennung = k.ersatzwert_kennung
                                     AND ew.ergebnis IN ('gebildet', 'ohne_wirkung')
                                     AND ew.fassung = (SELECT max(fassung) FROM messreihe_ersatzwert e
                                                        WHERE e.tenant_id = k.tenant_id AND e.kennung = ew.kennung)))
                    UNION ALL
                    SELECT n.tenant_id, n.kennung, 'ERSATZWERT', n.fassung, n.status, NULL::uuid, n.created_at
                      FROM (SELECT DISTINCT ON (tenant_id, kennung) tenant_id, kennung, fassung, status, created_at
                              FROM messreihe_ersatzwert ORDER BY tenant_id, kennung, fassung DESC) n
                      JOIN messreihe_ersatzwert_wirkung ew ON ew.tenant_id = n.tenant_id AND ew.kennung = n.kennung
                                                          AND ew.fassung >= n.fassung
                      LEFT JOIN messreihe_kaskade_wirkung w ON w.tenant_id = n.tenant_id AND w.anlass_kennung = n.kennung
                     WHERE n.fassung > coalesce(w.fassung, 0)
                       AND NOT EXISTS (SELECT 1 FROM messreihe_korrektur k WHERE k.tenant_id = n.tenant_id
                                        AND k.fassung = 1 AND k.ersatzwert_kennung = n.kennung)
                    UNION ALL
                    SELECT e.tenant_id, e.kennung, 'BEZUGSGROESSE', e.fassung, e.status, NULL::uuid, e.eingang
                      FROM (SELECT tenant_id, nutzlast ->> 'korrektur' AS kennung, nutzlast ->> 'status' AS status,
                                   coalesce((nutzlast ->> 'fassung_neu')::int, 1) AS fassung, eingang
                              FROM messreihe_ereignis
                             WHERE art = 'correction' AND (kennungen ->> 'bezugsgroesse') IS NOT NULL) e
                      LEFT JOIN messreihe_kaskade_wirkung w ON w.tenant_id = e.tenant_id AND w.anlass_kennung = e.kennung
                     WHERE e.status IN ('freigegeben', 'zurueckgenommen') AND e.fassung > coalesce(w.fassung, 0)
                    UNION ALL
                    SELECT f.tenant_id, 'kennzahl_fassung:' || f.kennzahl_id, 'DEFINITION', f.nummer,
                           'berechnung_geaendert', f.kennzahl_id, f.eingetragen_am
                      FROM kennzahl_fassung f
                      LEFT JOIN messreihe_kaskade_wirkung w ON w.tenant_id = f.tenant_id
                                                           AND w.anlass_kennung = 'kennzahl_fassung:' || f.kennzahl_id
                     WHERE f.rueckwirkend AND f.aufgehoben_am IS NULL AND f.nummer > coalesce(w.fassung, 0)
                    UNION ALL
                    SELECT s.tenant_id, 'bezugsgroesse_stammdatum:' || s.bezugsgroesse_id, 'STAMMDATUM', s.nr,
                           'stammdatum_eingetragen', s.bezugsgroesse_id, s.created_at
                      FROM (SELECT tenant_id, bezugsgroesse_id, rueckwirkend, created_at,
                                   row_number() OVER (PARTITION BY tenant_id, bezugsgroesse_id ORDER BY id)::int AS nr
                              FROM bezugsgroesse_aenderung WHERE art = 'stammdatum_eingetragen') s
                      LEFT JOIN messreihe_kaskade_wirkung w ON w.tenant_id = s.tenant_id
                                                           AND w.anlass_kennung = 'bezugsgroesse_stammdatum:' || s.bezugsgroesse_id
                     WHERE s.rueckwirkend AND s.nr > coalesce(w.fassung, 0)
                    UNION ALL
                    SELECT o.tenant_id, 'ort_flaeche:' || o.objekt_id, 'FLAECHE', o.nr, 'flaeche_geaendert',
                           o.objekt_id, o.created_at
                      FROM (SELECT tenant_id, objekt_id, rueckwirkend, created_at,
                                   row_number() OVER (PARTITION BY tenant_id, objekt_id ORDER BY id)::int AS nr
                              FROM ort_aenderung WHERE art = 'flaeche_geaendert') o
                      LEFT JOIN messreihe_kaskade_wirkung w ON w.tenant_id = o.tenant_id
                                                           AND w.anlass_kennung = 'ort_flaeche:' || o.objekt_id
                     WHERE o.rueckwirkend AND o.nr > coalesce(w.fassung, 0)
                       AND EXISTS (SELECT 1 FROM bezugsgroesse b
                                    WHERE b.tenant_id = o.tenant_id AND b.wertart = 'stammdatum'
                                      AND (b.standort_id = o.objekt_id OR b.ort_id = o.objekt_id)
                                      AND bezugsdaten_groesse(b.einheit) = 'flaeche')) a
                 ORDER BY created_at, kennung, fassung LIMIT ?
                """)) {
            ps.setInt(1, KANDIDATEN);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.add(new Anlass(rs.getObject(1, UUID.class), rs.getString(2), Quelle.valueOf(rs.getString(3)),
                            rs.getInt(4), rs.getString(5), rs.getObject(6, UUID.class)));
                }
            }
        }
        return aus;
    }

    // ============================================================================ Auslöser ohne Messreihe (AP-11 IP-9)

    /** Die Zeitzone einer Bezugsgröße {@code b}: die ihres Standorts {@code s}, sonst die des Unternehmens. */
    private static final String ZONE_DER_BEZUGSGROESSE = "coalesce(s.zeitzone, (SELECT u.zeitzone FROM unternehmen u "
            + "WHERE u.tenant_id = b.tenant_id ORDER BY u.id LIMIT 1), 'Europe/Berlin')";

    /**
     * Ein Anlass, der keine Messreihe berührt (AP-11 IP-9, E8 = A, W1): die Berichtigung oder Rücknahme eines
     * Bezugsgrößen-Werts ({@code correction} mit Bezug {@code bezugsgroesse}, Erzeuger AP-09 IP-7), eine rückwirkende
     * Fassung der Berechnung einer Kennzahl oder ein rückwirkend eingetragenes Stammdatum. Dieselbe Transaktion, derselbe
     * Takt, dieselbe Wirkung — aber NUR die Kennzahl- und die Berichts-Naht: keine Viertelstunde, keine Stufe, keine
     * berechnete Messstelle, keine Meldung {@code bilanz_neu_berechnet}. Als Versionen zählt die Wirkung die
     * Kennzahl-Werte, die die Naht in diesem Lauf schrieb.
     */
    private Verarbeitet ohneStufen(Connection con, Anlass a, Instant jetzt) throws SQLException {
        ZoneId zone = berechnete.zoneDesKundenbereichs(a.tenant());
        Betroffen betroffen = switch (a.quelle()) {
            case BEZUGSGROESSE -> nenner(con, a, zone, jetzt);
            case DEFINITION -> berechnung(con, a, zone, jetzt);
            case STAMMDATUM -> stammdatum(con, a, zone, jetzt);
            case FLAECHE -> flaeche(con, a, zone, jetzt);
            case KORREKTUR, ERSATZWERT -> throw new IllegalStateException("UEMS Korrektur-Kaskade: " + a.kennung()
                    + " geht durch die Stufen der Messreihe");
        };
        kennzahlen.nachKorrektur(con, betroffen);
        if (a.quelle().anBerichte()) {
            berichteBenachrichtigen(con, berichte, betroffen);
        }
        return new Verarbeitet(kennzahlWerte(con, a.tenant(), jetzt), List.of());
    }

    /**
     * {@code correction} mit Bezug {@code bezugsgroesse}: die Meldung (der Revisions-Auslöser), die Bezugsgröße — nach dem
     * Kennzeichen der Meldung, auch wenn sie heute ein anderes trägt — und die Tage ihrer Periode in ihrer Zeitzone.
     */
    private static Betroffen nenner(Connection con, Anlass a, ZoneId zone, Instant jetzt) throws SQLException {
        UUID ereignis;
        Instant von;
        Instant bis;
        String kennzeichen;
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT ereignis_id, von, bis, kennungen ->> 'bezugsgroesse'
                  FROM messreihe_ereignis
                 WHERE tenant_id = ? AND art = 'correction' AND (kennungen ->> 'bezugsgroesse') IS NOT NULL
                   AND nutzlast ->> 'korrektur' = ? AND coalesce((nutzlast ->> 'fassung_neu')::int, 1) = ?
                 ORDER BY eingang, ereignis_id LIMIT 1
                """)) {
            ps.setObject(1, a.tenant());
            ps.setString(2, a.kennung());
            ps.setInt(3, a.fassung());
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    throw new IllegalStateException("UEMS Korrektur-Kaskade: keine Meldung correction zu " + a.kennung()
                            + " Fassung " + a.fassung());
                }
                ereignis = rs.getObject(1, UUID.class);
                von = rs.getTimestamp(2).toInstant();
                bis = rs.getTimestamp(3).toInstant();
                kennzeichen = rs.getString(4);
            }
        }
        try (PreparedStatement ps = con.prepareStatement("SELECT b.id, b.kennzeichen, " + ZONE_DER_BEZUGSGROESSE
                + " FROM bezugsgroesse b LEFT JOIN standort s ON s.id = b.standort_id AND s.tenant_id = b.tenant_id "
                + "WHERE b.tenant_id = ? AND b.id = coalesce((SELECT id FROM bezugsgroesse WHERE tenant_id = ? "
                + "AND kennzeichen = ?), (SELECT bezugsgroesse_id FROM bezugsgroesse_kennzeichen_verlauf "
                + "WHERE tenant_id = ? AND kennzeichen = ?))")) {
            ps.setObject(1, a.tenant());
            ps.setObject(2, a.tenant());
            ps.setString(3, kennzeichen);
            ps.setObject(4, a.tenant());
            ps.setString(5, kennzeichen);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    throw new IllegalStateException("UEMS Korrektur-Kaskade: " + a.kennung() + " nennt die Bezugsgröße "
                            + kennzeichen + ", die es nicht gibt");
                }
                ZoneId eigene = ZoneId.of(rs.getString(3));
                LocalDate periodeVon = TagRegeln.tag(von, eigene);
                LocalDate periodeBis = TagRegeln.tag(bis.minusNanos(1), eigene);
                LocalDate ersterTag = fruehererTag(periodeVon, TagRegeln.tag(von, zone));
                LocalDate letzterTag = spaetererTag(periodeBis, TagRegeln.tag(bis.minusNanos(1), zone));
                return new Betroffen(a.tenant(), a.kennung(), a.fassung(), a.status(), List.of(), von, bis, zone,
                        ersterTag, letzterTag, List.of(), List.of(ereignis), 0, jetzt, List.of(new Bezugsgroesse(
                                rs.getObject(1, UUID.class), rs.getString(2), periodeVon, periodeBis, a.fassung(),
                                a.status())));
            }
        }
    }

    /** Eine rückwirkende Fassung der Berechnung: die Kennzahl, ab dem Tag der Fassung bis heute (oder ihrem letzten Tag). */
    private static Betroffen berechnung(Connection con, Anlass a, ZoneId zone, Instant jetzt) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("SELECT k.kennzeichen, f.gueltig_ab, f.gueltig_bis "
                + "FROM kennzahl_fassung f JOIN kennzahl k ON k.id = f.kennzahl_id AND k.tenant_id = f.tenant_id "
                + "WHERE f.tenant_id = ? AND f.kennzahl_id = ? AND f.nummer = ?")) {
            ps.setObject(1, a.tenant());
            ps.setObject(2, a.objekt());
            ps.setInt(3, a.fassung());
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    throw new IllegalStateException("UEMS Korrektur-Kaskade: " + a.kennung() + " Fassung " + a.fassung()
                            + " nicht gefunden");
                }
                LocalDate ab = rs.getObject(2, LocalDate.class);
                LocalDate bisTag = bisHeute(ab, rs.getObject(3, LocalDate.class), zone, jetzt);
                return new Betroffen(a.tenant(), rs.getString(1), a.fassung(), a.status(), List.of(),
                        ab.atStartOfDay(zone).toInstant(), bisTag.plusDays(1).atStartOfDay(zone).toInstant(), zone, ab,
                        bisTag, List.of(), List.of(), 0, jetzt, List.of());
            }
        }
    }

    /** Ein rückwirkend eingetragenes Stammdatum: die Bezugsgröße, ab dem Tag, ab dem es gilt, bis heute. */
    private static Betroffen stammdatum(Connection con, Anlass a, ZoneId zone, Instant jetzt) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("SELECT b.kennzeichen, e.gilt_ab, " + ZONE_DER_BEZUGSGROESSE
                + " FROM (SELECT bezugsgroesse_id, gilt_ab, row_number() OVER (ORDER BY id)::int AS nr "
                + "FROM bezugsgroesse_aenderung WHERE tenant_id = ? AND bezugsgroesse_id = ? "
                + "AND art = 'stammdatum_eingetragen') e "
                + "JOIN bezugsgroesse b ON b.id = e.bezugsgroesse_id AND b.tenant_id = ? "
                + "LEFT JOIN standort s ON s.id = b.standort_id AND s.tenant_id = b.tenant_id WHERE e.nr = ?")) {
            ps.setObject(1, a.tenant());
            ps.setObject(2, a.objekt());
            ps.setObject(3, a.tenant());
            ps.setInt(4, a.fassung());
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    throw new IllegalStateException("UEMS Korrektur-Kaskade: " + a.kennung() + " Eintrag " + a.fassung()
                            + " nicht gefunden");
                }
                LocalDate ab = TagRegeln.tag(rs.getTimestamp(2).toInstant(), ZoneId.of(rs.getString(3)));
                LocalDate bisTag = bisHeute(ab, null, zone, jetzt);
                return new Betroffen(a.tenant(), rs.getString(1), a.fassung(), a.status(), List.of(),
                        ab.atStartOfDay(zone).toInstant(), bisTag.plusDays(1).atStartOfDay(zone).toInstant(), zone, ab,
                        bisTag, List.of(), List.of(), 0, jetzt,
                        List.of(new Bezugsgroesse(a.objekt(), rs.getString(1), ab, bisTag, a.fassung(), a.status())));
            }
        }
    }

    /**
     * Eine rückwirkend geänderte BEZUGSFLÄCHE (AP-02, die Fläche eines Orts): der Ort, ab dem Tag, ab dem die neue
     * Fläche gilt, bis heute — und KEINEN Tag früher. Betroffen ist jede Kennzahl, die die Bezugsfläche dieses Orts als
     * Nenner liest; sie hängt an der Bezugsgröße, die als Zeiger darauf gebunden ist.
     *
     * <p>Die Fläche selbst bleibt, wo sie ist: hier wird nur gelesen, welcher Tag sich geändert hat.
     */
    private static Betroffen flaeche(Connection con, Anlass a, ZoneId zone, Instant jetzt) throws SQLException {
        LocalDate ab;
        String kurzzeichen;
        try (PreparedStatement ps = con.prepareStatement(
                "SELECT e.gilt_ab, coalesce(s.kurzzeichen, o.kurzzeichen) AS kurzzeichen "
                + "FROM (SELECT objekt_id, gilt_ab, row_number() OVER (ORDER BY id)::int AS nr FROM ort_aenderung "
                + "WHERE tenant_id = ? AND objekt_id = ? AND art = 'flaeche_geaendert') e "
                + "LEFT JOIN standort s ON s.id = e.objekt_id AND s.tenant_id = ? "
                + "LEFT JOIN ort o ON o.id = e.objekt_id AND o.tenant_id = ? WHERE e.nr = ?")) {
            ps.setObject(1, a.tenant());
            ps.setObject(2, a.objekt());
            ps.setObject(3, a.tenant());
            ps.setObject(4, a.tenant());
            ps.setInt(5, a.fassung());
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    throw new IllegalStateException("UEMS Korrektur-Kaskade: " + a.kennung() + " Eintrag " + a.fassung()
                            + " nicht gefunden");
                }
                ab = rs.getObject(1, LocalDate.class);
                kurzzeichen = rs.getString(2);
            }
        }
        LocalDate bisTag = bisHeute(ab, null, zone, jetzt);
        List<Bezugsgroesse> flaechen = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("SELECT b.id, b.kennzeichen FROM bezugsgroesse b "
                + "WHERE b.tenant_id = ? AND b.wertart = 'stammdatum' AND (b.standort_id = ? OR b.ort_id = ?) "
                + "AND bezugsdaten_groesse(b.einheit) = 'flaeche' ORDER BY b.kennzeichen, b.id")) {
            ps.setObject(1, a.tenant());
            ps.setObject(2, a.objekt());
            ps.setObject(3, a.objekt());
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    flaechen.add(new Bezugsgroesse(rs.getObject(1, UUID.class), rs.getString(2), ab, bisTag,
                            a.fassung(), a.status()));
                }
            }
        }
        return new Betroffen(a.tenant(), kurzzeichen == null ? a.kennung() : kurzzeichen, a.fassung(), a.status(),
                List.of(), ab.atStartOfDay(zone).toInstant(), bisTag.plusDays(1).atStartOfDay(zone).toInstant(), zone,
                ab, bisTag, List.of(), List.of(), 0, jetzt, List.copyOf(flaechen));
    }

    /** Der letzte Tag einer Neubildung ab {@code ab}: heute — oder früher der letzte Tag der Fassung; nie vor {@code ab}. */
    private static LocalDate bisHeute(LocalDate ab, LocalDate letzter, ZoneId zone, Instant jetzt) {
        LocalDate heute = TagRegeln.tag(jetzt, zone);
        LocalDate bis = letzter != null && letzter.isBefore(heute) ? letzter : heute;
        return bis.isBefore(ab) ? ab : bis;
    }

    private static LocalDate fruehererTag(LocalDate a, LocalDate b) {
        return a.isBefore(b) ? a : b;
    }

    private static LocalDate spaetererTag(LocalDate a, LocalDate b) {
        return a.isAfter(b) ? a : b;
    }

    /** Die Kennzahl-Werte, die die Naht in diesem Lauf schrieb — sie tragen {@code berechnet_am} = der Lauf. */
    private static int kennzahlWerte(Connection con, UUID tenant, Instant jetzt) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement(
                "SELECT count(*) FROM kennzahl_wert WHERE tenant_id = ? AND berechnet_am = ?")) {
            ps.setObject(1, tenant);
            ps.setTimestamp(2, Timestamp.from(jetzt.truncatedTo(ChronoUnit.MICROS)));
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getInt(1);
            }
        }
    }

    // ============================================================================ Einen Anlass verarbeiten

    private record Verarbeitet(int versionen, List<BerechnetePeriode.Abgelehnt> kreise) {}

    /** Eine Korrektur (Fassung 1) mit ihren Entscheidungen. */
    private record Korrektur(String kennung, String art, List<Reihe> reihen, Instant von, Instant bis, JsonNode vorschau,
            List<Entscheidung> entscheidungen, String ersatzwert) {}

    private record Entscheidung(int fassung, String status) {}

    private Verarbeitet verarbeiten(Connection con, Anlass a, Instant jetzt) throws SQLException {
        List<Reihe> reihen;
        Instant von;
        Instant bis;
        int versionen = 0;
        Korrektur k = null;
        if (a.korrektur()) {
            k = korrektur(con, a.tenant(), a.kennung());
            if ("ablesung".equals(k.vorschau().path(0).path("spur").asText())) {
                return ablesungWeiter(con, a, k, jetzt);
            }
            reihen = k.reihen();
            von = k.von();
            bis = k.bis();
            if (!ART_ERSATZWERT.equals(k.art())) {
                if (reihen.size() != 1) {
                    throw new Abgelehnt(VORSCHAU_FEHLT, "die Vorschau je Viertelstunde nennt keine Reihe, die Korrektur "
                            + "hat " + reihen.size());
                }
                Map<Instant, KorrekturVorschlagRegeln.Stand> neu = vorschau(k.vorschau());
                if (neu.isEmpty()) {
                    throw new Abgelehnt(VORSCHAU_FEHLT, "keine Viertelstunde in der Vorschau");
                }
                Reihe r = reihen.get(0);
                KaskadeStufen.Reihe kr = new KaskadeStufen.Reihe(a.tenant(), r.entity(), r.kanal());
                // Dieselbe Sperre wie der Ersatzwert-Lauf: wer Viertelstunden-Versionen anhängt, tut es nacheinander.
                sperre(con, "uems-ersatzwert:" + a.tenant() + ":" + r.entity() + ":" + r.kanal(), true);
                versionen += FREIGEGEBEN.equals(a.status())
                        ? anwenden(con, a, k, kr, neu, jetzt)
                        : zuruecknehmen(con, a, kr, neu);
                Instant erste = ((TreeMap<Instant, KorrekturVorschlagRegeln.Stand>) neu).firstKey();
                Instant letzte = ((TreeMap<Instant, KorrekturVorschlagRegeln.Stand>) neu).lastKey()
                        .plus(KaskadeStufen.VIERTELSTUNDE);
                von = erste.isBefore(von) ? erste : von;
                bis = letzte.isAfter(bis) ? letzte : bis;
            }
        } else {
            Reihe r = ersatzwertReihe(con, a.tenant(), a.kennung());
            reihen = List.of(r);
            Instant[] zeitraum = ersatzwertZeitraum(con, a.tenant(), a.kennung());
            von = zeitraum[0];
            bis = zeitraum[1];
        }

        for (Reihe r : reihen) {
            versionen += stufenDerReihe(con, a, new KaskadeStufen.Reihe(a.tenant(), r.entity(), r.kanal()), von, bis,
                    jetzt, Modus.ANLASS);
        }

        ZoneId zone = berechnete.zoneDesKundenbereichs(a.tenant());
        LocalDate ersterTag = TagRegeln.tag(von, zone);
        LocalDate letzterTag = TagRegeln.tag(bis.minusNanos(1), zone);
        Berechnet b = berechneteStufen(con, a.tenant(), a.kennung(), a.fassung(), ersterTag, letzterTag, ALLE_EBENEN,
                jetzt, Modus.ANLASS);
        versionen += b.versionen();

        List<UUID> ereignisse = new ArrayList<>();
        if (k != null) {
            for (Entscheidung e : k.entscheidungen()) {
                if (e.fassung() <= wirkungFassung(con, a.tenant(), a.kennung())) {
                    continue;
                }
                for (Reihe r : reihen) {
                    ereignisse.add(correction(con, a.tenant(), k, e.status(), r, jetzt));
                }
            }
        }

        // AP-10 IP-11: wessen Bilanz-Werte (berechnete Versionen, verteilte Werte) sich geändert haben — in DIESER
        // Transaktion gemeldet, gerechnet hat die Kaskade oben.
        BilanzNeuBerechnet.melden(con, a.tenant(), a.kennung(), a.fassung(), a.status(), reihen, von, bis, zone,
                ersterTag, letzterTag, b.messstellen(), versionen, jetzt);

        Betroffen betroffen = new Betroffen(a.tenant(), a.kennung(), a.fassung(), a.status(), List.copyOf(reihen), von,
                bis, zone, ersterTag, letzterTag, b.messstellen(), List.copyOf(ereignisse), versionen, jetzt);
        kennzahlen.nachKorrektur(con, betroffen);
        berichteBenachrichtigen(con, berichte, betroffen);
        return new Verarbeitet(versionen, b.kreise());
    }

    /** Ablesungen haben ihre Fassungen schon; die vorhandene Kaskade bildet alle abhängigen Werte. */
    private Verarbeitet ablesungWeiter(Connection con, Anlass a, Korrektur k, Instant jetzt) throws SQLException {
        UUID id = UUID.fromString(k.vorschau().get(0).path("messstelle_id").asText());
        String kennzeichen;
        try (PreparedStatement ps = con.prepareStatement("SELECT kennzeichen FROM messstelle WHERE tenant_id=? AND id=?")) {
            ps.setObject(1, a.tenant()); ps.setObject(2, id);
            try (ResultSet rs = ps.executeQuery()) { rs.next(); kennzeichen = rs.getString(1); }
        }
        ZoneId zone = berechnete.zoneDesKundenbereichs(a.tenant());
        LocalDate von = TagRegeln.tag(k.von(), zone);
        LocalDate bis = TagRegeln.tag(k.bis().minusNanos(1), zone);
        Berechnet b = berechneteStufen(con, a.tenant(), a.kennung(), a.fassung(), von, bis, ALLE_EBENEN, jetzt, Modus.ANLASS);
        List<String> messstellen = new ArrayList<>(b.messstellen());
        messstellen.add(kennzeichen);
        List<UUID> ereignisse = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("SELECT DISTINCT ereignis_id FROM messreihe_ereignis "
                + "WHERE tenant_id=? AND art='correction' AND nutzlast->>'korrektur'=?")) {
            ps.setObject(1,a.tenant()); ps.setString(2,a.kennung());
            try (ResultSet rs=ps.executeQuery()) { while (rs.next()) ereignisse.add(rs.getObject(1,UUID.class)); }
        }
        Betroffen betroffen = new Betroffen(a.tenant(),a.kennung(),a.fassung(),a.status(),List.of(),k.von(),k.bis(),
                zone,von,bis,List.copyOf(messstellen),List.copyOf(ereignisse),b.versionen(),jetzt);
        kennzahlen.nachKorrektur(con, betroffen);
        berichteBenachrichtigen(con, berichte, betroffen);
        return new Verarbeitet(b.versionen(), b.kreise());
    }

    /**
     * Die GRENZE von E9, an EINER Stelle: ein Bericht-Entwurf bildet sich neu, ein freigegebener Bericht bekommt NUR den
     * Revisions-Auslöser — nie {@link BerichteNaht#entwurfNeuBilden}. Die Implementierung der Naht entscheidet das nicht.
     */
    static void berichteBenachrichtigen(Connection con, BerichteNaht naht, Betroffen betroffen) throws SQLException {
        for (BerichteNaht.Bericht bericht : naht.betroffene(con, betroffen)) {
            switch (bericht.stand()) {
                case ENTWURF -> naht.entwurfNeuBilden(con, bericht, betroffen);
                case FREIGEGEBEN -> naht.revisionAusloesen(con, bericht, betroffen);
            }
        }
    }

    // ============================================================================ Die Viertelstunden einer Korrektur

    /**
     * FREIGABE: jede Viertelstunde der Vorschau bekommt den freigegebenen Stand „neu“ als nächste Version — mit den
     * Rohwert-Fakten, aus denen er gerechnet wurde. Die Fakten kommen aus derselben Zeile, aus der die Vorschau „neu“
     * kam ({@link ViertelstundeVerdichter#waereZeile}); sagt sie heute etwas anderes, als freigegeben wurde, ist das eine
     * neue Tatsache und wird benannt abgelehnt (der nächste Vorschlag zeigt sie).
     */
    private int anwenden(Connection con, Anlass a, Korrektur k, KaskadeStufen.Reihe r,
            Map<Instant, KorrekturVorschlagRegeln.Stand> neu, Instant jetzt) throws SQLException {
        Instant von = ((TreeMap<Instant, KorrekturVorschlagRegeln.Stand>) neu).firstKey();
        Instant bis = ((TreeMap<Instant, KorrekturVorschlagRegeln.Stand>) neu).lastKey().plus(KaskadeStufen.VIERTELSTUNDE);
        Map<Instant, List<ViertelVersion>> versionen = KaskadeStufen.viertelVersionen(con, r, von, bis);
        Map<Instant, Inhalt> bestand = KaskadeStufen.viertelBestand(con, r, von, bis);
        Map<Instant, Instant> berechnetAm = viertelBerechnetAm(con, r, von, bis);
        int geschrieben = 0;
        for (Map.Entry<Instant, KorrekturVorschlagRegeln.Stand> e : neu.entrySet()) {
            Instant q = e.getKey();
            KorrekturVorschlagRegeln.Stand soll = e.getValue();
            List<ViertelVersion> vs = versionen.getOrDefault(q, List.of());
            ViertelVersion neueste = vs.isEmpty() ? null : vs.get(vs.size() - 1);
            if (neueste != null && neueste.korrekturen() == null && !neueste.ersatzwerte().isEmpty()) {
                throw new Abgelehnt(UEBERSCHNEIDET_ERSATZWERT, "Viertelstunde " + q + " trägt "
                        + String.join(", ", neueste.ersatzwerte()));
            }
            Inhalt fakten = fakten(con, a, k, r, q, soll, bestand.get(q), jetzt);
            Inhalt inhalt = new Inhalt(fakten.wertart(), soll.menge(), soll.mengeZustand(), soll.kennzeichen(),
                    soll.erhalten(), soll.erwartet(), soll.abdeckungProzent(), fakten.standAnfang(), fakten.standEnde(),
                    fakten.erster(), fakten.letzter(), fakten.summe(), soll.mittel(), fakten.min(), fakten.max(),
                    soll.energie(), fakten.gemessenS(), fakten.lueckeInnen(), null, fakten.positiv(), fakten.negativ());
            Inhalt ist = neueste != null ? neueste.inhalt() : bestand.get(q);
            if (ist != null ? viertelGleich(inhalt, ist) : inhalt.leer()) {
                continue;
            }
            List<String> korrekturen = new ArrayList<>(neueste == null || neueste.korrekturen() == null ? List.of()
                    : neueste.korrekturen());
            korrekturen.remove(k.kennung());
            korrekturen.add(k.kennung());
            KaskadeStufen.viertelSchreiben(con, r, q, neueste == null ? 2 : neueste.version() + 1, inhalt, null,
                    List.of(), korrekturen, a.kennung(), a.fassung(), berechnetAm.get(q));
            geschrieben++;
        }
        return geschrieben;
    }

    /**
     * Die Rohwert-Fakten einer Viertelstunde für den freigegebenen Stand: aus der Zeile, die die Verdichtung heute
     * schriebe. Nachlieferung und Ablesestände rechnet sie selbst nach (dieselbe Zeile wie die Vorschau „neu“); eine
     * Umklassifizierung rechnet mit einer bestätigten Deklaration, die nicht gespeichert ist — dort müssen nur die
     * gezählten Werte dieselben sein; ein berichtigter Wert (mit Beleg) hat die Fakten von Version 1.
     *
     * <p>Das Richtungspaar ({@code energie_positiv}/{@code _negativ}, V20260923231500) reist mit den Rohwert-Fakten:
     * aus derselben Zeile wie {@code energie}, und nur, wenn deren Energie die freigegebene ist — sonst beschriebe es
     * andere Rohwerte. Ein berichtigter Wert setzt eine Nettomenge ohne Richtung: kein Paar (unbekannt, nie 0).
     */
    private Inhalt fakten(Connection con, Anlass a, Korrektur k, KaskadeStufen.Reihe r, Instant q,
            KorrekturVorschlagRegeln.Stand soll, Inhalt bestand, Instant jetzt) throws SQLException {
        if (!ART_NACHLIEFERUNG.equals(k.art()) && !ART_ABLESESTAENDE.equals(k.art())
                && !ART_UMKLASSIFIZIERUNG.equals(k.art())) {
            return bestand != null ? bestand.mitRichtung(null) : leererInhalt();
        }
        Map<String, Object> z = verdichter.waereZeile(con, r.tenant(), r.entity(), r.kanal(), q, jetzt, null);
        if (z == null) {
            if (soll.erhalten() != null && soll.erhalten() > 0) {
                throw new Abgelehnt(ROHWERTE_FEHLEN, "Viertelstunde " + q + " von " + a.kennung());
            }
            return leererInhalt();
        }
        KorrekturVorschlagRegeln.Stand heute = new KorrekturVorschlagRegeln.Stand(null, (BigDecimal) z.get("menge"),
                zustand((String) z.get("menge_zustand")), ViertelstundenTeile.kennzeichen((String) z.get("kennzeichen")),
                (Integer) z.get("erhalten"), (Integer) z.get("erwartet"), (Integer) z.get("abdeckung_prozent"),
                (BigDecimal) z.get("mittel"), (BigDecimal) z.get("energie"));
        boolean stimmt = ART_UMKLASSIFIZIERUNG.equals(k.art())
                ? Objects.equals(heute.erhalten(), soll.erhalten()) && Objects.equals(heute.erwartet(), soll.erwartet())
                        && Objects.equals(heute.abdeckungProzent(), soll.abdeckungProzent())
                : heute.gleich(soll);
        if (!stimmt) {
            throw new Abgelehnt(VORSCHAU_VERALTET, "Viertelstunde " + q + " von " + a.kennung());
        }
        BigDecimal energie = (BigDecimal) z.get("energie");
        boolean paarGilt = energie != null && soll.energie() != null && energie.compareTo(soll.energie()) == 0;
        return new Inhalt((String) z.get("wertart"), null, null, List.of(), null, null, null,
                rohwert(z, "stand_anfang"), rohwert(z, "stand_ende"), rohwert(z, "erster_wert", "erster_zeit"),
                rohwert(z, "letzter_wert", "letzter_zeit"), (BigDecimal) z.get("summe"), null,
                (BigDecimal) z.get("min_wert"), (BigDecimal) z.get("max_wert"), null, (Integer) z.get("gemessen_s"),
                (Boolean) z.get("luecke_innen"), null, paarGilt ? (BigDecimal) z.get("energie_positiv") : null,
                paarGilt ? (BigDecimal) z.get("energie_negativ") : null);
    }

    /**
     * RÜCKNAHME: jede Viertelstunde, deren NEUESTE Version diese Korrektur schrieb, bekommt den Stand davor als nächste
     * Version — die Version vor ihr, oder Version 1. Hat eine spätere Entscheidung die Viertelstunde schon wieder
     * überschrieben, bleibt sie, wie sie ist: die spätere gilt.
     */
    private int zuruecknehmen(Connection con, Anlass a, KaskadeStufen.Reihe r,
            Map<Instant, KorrekturVorschlagRegeln.Stand> neu) throws SQLException {
        Instant von = ((TreeMap<Instant, KorrekturVorschlagRegeln.Stand>) neu).firstKey();
        Instant bis = ((TreeMap<Instant, KorrekturVorschlagRegeln.Stand>) neu).lastKey().plus(KaskadeStufen.VIERTELSTUNDE);
        Map<Instant, List<ViertelVersion>> versionen = KaskadeStufen.viertelVersionen(con, r, von, bis);
        Map<Instant, Inhalt> bestand = KaskadeStufen.viertelBestand(con, r, von, bis);
        Map<Instant, Instant> berechnetAm = viertelBerechnetAm(con, r, von, bis);
        int geschrieben = 0;
        for (Map.Entry<Instant, List<ViertelVersion>> e : versionen.entrySet()) {
            List<ViertelVersion> vs = e.getValue();
            ViertelVersion neueste = vs.get(vs.size() - 1);
            if (!a.kennung().equals(neueste.anlassKennung())) {
                continue;
            }
            ViertelVersion davor = vs.size() >= 2 ? vs.get(vs.size() - 2) : null;
            Inhalt ziel = davor != null ? davor.inhalt() : bestand.get(e.getKey());
            if (ziel == null) {
                ziel = leererInhalt();
            }
            Inhalt fakten = davor != null && davor.korrekturen() != null ? davor.inhalt()
                    : bestand.getOrDefault(e.getKey(), leererInhalt());
            Inhalt inhalt = new Inhalt(fakten.wertart(), ziel.menge(), ziel.mengeZustand(), ziel.aussage(),
                    fakten.erhalten(), fakten.erwartet(), fakten.abdeckung(), fakten.standAnfang(), fakten.standEnde(),
                    fakten.erster(), fakten.letzter(), fakten.summe(), fakten.mittel(), fakten.min(), fakten.max(),
                    fakten.energie(), fakten.gemessenS(), fakten.lueckeInnen(), null, fakten.positiv(),
                    fakten.negativ());
            List<String> korrekturen = davor == null || davor.korrekturen() == null ? List.of() : davor.korrekturen();
            KaskadeStufen.viertelSchreiben(con, r, e.getKey(), neueste.version() + 1, inhalt,
                    davor == null ? null : davor.anteil(), davor == null ? List.of() : davor.ersatzwerte(), korrekturen,
                    a.kennung(), a.fassung(), berechnetAm.get(e.getKey()));
            geschrieben++;
        }
        return geschrieben;
    }

    private static boolean viertelGleich(Inhalt soll, Inhalt ist) {
        return Objects.equals(soll.mengeZustand(), ist.mengeZustand())
                && (soll.menge() == null ? ist.menge() == null : ist.menge() != null
                        && soll.menge().compareTo(ist.menge()) == 0)
                && soll.aussage().equals(ist.aussage()) && Objects.equals(soll.erhalten(), ist.erhalten())
                && Objects.equals(soll.erwartet(), ist.erwartet()) && Objects.equals(soll.abdeckung(), ist.abdeckung());
    }

    // ============================================================================ Tag, Monat, Jahr der Reihe

    /** Alle Tage der Reihe, die {@code [von, bis)} berühren, ihre Monate und ihre Jahre — in dieser Reihenfolge. */
    private int stufenDerReihe(Connection con, Anlass a, KaskadeStufen.Reihe r, Instant von, Instant bis, Instant jetzt,
            Modus modus) throws SQLException {
        ZoneId zone = ReihenKontext.zeitzonen(con, List.of(new ReihenKontext.Frage(r.tenant(), r.entity(),
                LocalDate.ofInstant(von, ZoneOffset.UTC)))).get(0).zone();
        LocalDate erster = TagRegeln.tag(von, zone);
        LocalDate letzter = TagRegeln.tag(bis.minusNanos(1), zone);
        Set<LocalDate> monate = new TreeSet<>();
        Set<LocalDate> jahre = new TreeSet<>();
        int n = 0;
        for (LocalDate tag = erster; !tag.isAfter(letzter); tag = tag.plusDays(1)) {
            n += stufe(con, a.kennung(), a.fassung(), r, KaskadeStufen.TAG, tag, zone, jetzt, modus);
            monate.add(tag.withDayOfMonth(1));
            jahre.add(tag.withDayOfYear(1));
        }
        for (LocalDate monat : monate) {
            n += stufe(con, a.kennung(), a.fassung(), r, KaskadeStufen.MONAT, monat, zone, jetzt, modus);
        }
        for (LocalDate jahr : jahre) {
            n += stufe(con, a.kennung(), a.fassung(), r, KaskadeStufen.JAHR, jahr, zone, jetzt, modus);
        }
        return n;
    }

    private int stufe(Connection con, String anlass, int fassung, KaskadeStufen.Reihe r, String ebene, LocalDate tag,
            ZoneId vorgabe, Instant jetzt, Modus modus) throws SQLException {
        ZoneId zone = Objects.requireNonNullElse(KaskadeStufen.zoneDerZeile(con, r, ebene, tag), vorgabe);
        Instant beginn = TagRegeln.beginn(tag, zone);
        Instant ende = switch (ebene) {
            case KaskadeStufen.TAG -> TagRegeln.ende(tag, zone);
            case KaskadeStufen.MONAT -> TagRegeln.beginn(tag.plusMonths(1), zone);
            default -> TagRegeln.beginn(tag.plusYears(1), zone);
        };
        Gespeichert v1 = KaskadeStufen.bestand(con, r, ebene, tag);
        Gebildet soll = switch (ebene) {
            case KaskadeStufen.TAG -> stufen.tag(con, r, tag, zone, v1, jetzt);
            case KaskadeStufen.MONAT -> stufen.monat(con, r, tag, zone, v1);
            default -> stufen.jahr(con, r, tag, zone, v1);
        };
        Gespeichert neueste = KaskadeStufen.neuesteVersion(con, r.tenant(), r.entity(), r.kanal(), null, ebene, beginn);
        Periode p = new Periode(r.tenant(), ebene, r.entity(), r.kanal(), null, beginn, ende, tag, zone);
        boolean bezug = soll != null && (!soll.korrekturen().isEmpty() || !soll.ersatzwerte().isEmpty()
                || mitViertelVersion(con, r, beginn, ende));
        return vergleichen(con, p, soll, neueste, v1, bezug, anlass, fassung, modus);
    }

    /**
     * Der Vergleich, an dem jede Stufe hängt: weicht die gebildete Stufe von ihrer neuesten gespeicherten Fassung ab,
     * entsteht die nächste Version (Anlass) oder die neueste vorläufige zieht nach (Nachzug). Eine ERSTE Version bekommt
     * eine Periode nur, wenn in ihr etwas wirkt (eine Korrektur, ein Ersatzwert, eine Viertelstunden-Version) — eine
     * Version 1, die die Verdichtung nur noch nicht neu gebildet hat, ist deren Sache, nicht die der Kaskade.
     *
     * @return 1, wenn geschrieben wurde
     */
    private static int vergleichen(Connection con, Periode p, Gebildet soll, Gespeichert neueste, Gespeichert v1,
            boolean bezug, String anlass, int fassung, Modus modus) throws SQLException {
        Gespeichert ist = neueste != null ? neueste : v1;
        Inhalt inhalt = soll != null ? soll.inhalt() : null;
        if (inhalt == null) {
            if (neueste == null) {
                return 0;
            }
            inhalt = leererInhalt().mitZustand(neueste.inhalt().zustand());
        }
        List<String> korrekturen = soll == null ? List.of() : soll.korrekturen();
        List<String> ersatzwerte = soll == null ? List.of() : soll.ersatzwerte();
        // Gleich ist eine Stufe nur, wenn sie dasselbe sagt UND dasselbe in ihr wirkt: nach einer Rücknahme trägt eine
        // Version mit denselben Zahlen, die die zurückgenommene Korrektur noch nennt, eine Version, die es nicht mehr gibt.
        if (ist != null ? inhalt.gleich(ist.inhalt()) && Set.copyOf(korrekturen).equals(Set.copyOf(ist.korrekturen()))
                && Set.copyOf(ersatzwerte).equals(Set.copyOf(ist.ersatzwerte())) : inhalt.leer()) {
            return 0;
        }
        Instant basis = v1 == null ? null : v1.basisBerechnetAm();
        if (modus == Modus.NACHZUG) {
            if (neueste == null || !ViertelstundeRegeln.VORLAEUFIG.equals(neueste.inhalt().zustand())) {
                return 0;
            }
            KaskadeStufen.periodeNachziehen(con, p, neueste.version(), inhalt, korrekturen, ersatzwerte, basis);
            return 1;
        }
        if (neueste == null && !bezug) {
            return 0;
        }
        KaskadeStufen.periodeSchreiben(con, p, neueste == null ? 2 : neueste.version() + 1, inhalt, korrekturen,
                ersatzwerte, anlass, fassung, basis);
        return 1;
    }

    private static boolean mitViertelVersion(Connection con, KaskadeStufen.Reihe r, Instant von, Instant bis)
            throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("SELECT EXISTS (SELECT 1 FROM messreihe_viertelstunde_version "
                + "WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? AND intervall_beginn >= ? "
                + "AND intervall_beginn < ?)")) {
            ps.setObject(1, r.tenant());
            ps.setObject(2, r.entity());
            ps.setString(3, r.kanal());
            ps.setTimestamp(4, Timestamp.from(von));
            ps.setTimestamp(5, Timestamp.from(bis));
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getBoolean(1);
            }
        }
    }

    // ============================================================================ Die berechneten Messstellen (AP-10)

    private record Berechnet(int versionen, List<String> messstellen, List<BerechnetePeriode.Abgelehnt> kreise) {}

    /**
     * Der Hook an {@link BerechnetePeriodenLauf#nachKorrektur}: dieselbe Ordnung, derselbe Kreis, dieselbe Rechnung —
     * mit den Eingängen in ihrer neuesten Version. Eine Messstelle nach der anderen, in DIESER Transaktion: was eine
     * berechnete Messstelle eben als Version schrieb, liest die nächste schon.
     */
    private static final Set<String> ALLE_EBENEN = Set.of(BerechnetePeriodenRepository.VIERTELSTUNDE,
            BerechnetePeriodenRepository.TAG, BerechnetePeriodenRepository.MONAT, BerechnetePeriodenRepository.JAHR);

    private Berechnet berechneteStufen(Connection con, UUID tenant, String anlass, int fassung, LocalDate von,
            LocalDate bis, Set<String> ebenen, Instant jetzt, Modus modus) throws SQLException {
        int[] versionen = {0};
        List<String> messstellen = new ArrayList<>();
        Map<String, List<String>> wirkt = new HashMap<>();
        List<BerechnetePeriode.Abgelehnt> kreise = berechnete.nachKorrektur(tenant, von, bis, ebenen, jetzt,
                (k, ref, ebene, v, b, gelesen) -> ueberlagern(con, tenant, ref, ebene, k.zone(), v, b, gelesen, wirkt),
                n -> {
                    sperre(con, "uems-berechnet:" + tenant + ":" + n.messstelle().id(), true);
                    int vorher = versionen[0];
                    for (BerechnetePeriodenRepository.Zeile z : n.zeilen()) {
                        versionen[0] += berechneteZeile(con, tenant, n.messstelle().id(), z, anlass, fassung, jetzt,
                                modus, wirkt);
                    }
                    if (versionen[0] > vorher) {
                        messstellen.add(n.messstelle().kennzeichen());
                    }
                });
        return new Berechnet(versionen[0], List.copyOf(messstellen), kreise);
    }

    private static int berechneteZeile(Connection con, UUID tenant, UUID messstelle, BerechnetePeriodenRepository.Zeile z,
            String anlass, int fassung, Instant jetzt, Modus modus, Map<String, List<String>> wirkt)
            throws SQLException {
        BerechnetePeriode.Ergebnis e = z.ergebnis();
        Inhalt inhalt = new Inhalt(null, e.menge(), e.mengeZustand(), e.kennzeichen(), null, null,
                e.abdeckungProzent(), null, null, null, null, null, null, null, null, null, null, null, e.zustand());
        Gespeichert v1 = berechneterBestand(con, tenant, messstelle, z.ebene(), z.beginn());
        Gespeichert neueste = KaskadeStufen.neuesteVersion(con, tenant, null, null, messstelle, z.ebene(), z.beginn());
        Set<String> korrekturen = new LinkedHashSet<>();
        Set<String> ersatzwerte = new LinkedHashSet<>();
        boolean bezug = false;
        for (BerechnetePeriodenRepository.EingangZeile ez : z.eingaenge()) {
            Integer version = ez.eingang().version();
            bezug |= version != null && version > 1;
            List<String> w = wirkt.get(schluessel(ez.messstelleId(), ez.entityId(), ez.messkanal(), z.ebene(), z.beginn()));
            if (w != null) {
                w.stream().filter(x -> x.startsWith("K-")).forEach(korrekturen::add);
                w.stream().filter(x -> x.startsWith("EW-")).forEach(ersatzwerte::add);
            }
        }
        Periode p = new Periode(tenant, z.ebene(), null, null, messstelle, z.beginn(), z.ende(), z.tag(),
                z.zone() != null ? z.zone() : ZoneOffset.UTC);
        Gebildet soll = new Gebildet(inhalt, List.copyOf(korrekturen), List.copyOf(ersatzwerte));
        int n = vergleichen(con, p, soll, neueste, v1, bezug, anlass, fassung, modus);
        if (n > 0) {
            int version = modus == Modus.NACHZUG ? neueste.version() : neueste == null ? 2 : neueste.version() + 1;
            if (modus == Modus.NACHZUG) {
                try (PreparedStatement ps = con.prepareStatement("DELETE FROM bilanzwert_eingang WHERE tenant_id = ? "
                        + "AND messstelle_id = ? AND periode = ? AND periode_beginn = ? AND version = ?")) {
                    ps.setObject(1, tenant);
                    ps.setObject(2, messstelle);
                    ps.setString(3, z.ebene());
                    ps.setTimestamp(4, Timestamp.from(z.beginn()));
                    ps.setInt(5, version);
                    ps.executeUpdate();
                }
            }
            BerechnetePeriodenRepository.eingaengeEinfuegen(con, tenant, messstelle, z, version, jetzt);
        }
        return n;
    }

    /** Version 1 einer berechneten Periode — {@code null} ohne Zeile. */
    private static Gespeichert berechneterBestand(Connection con, UUID tenant, UUID messstelle, String ebene,
            Instant beginn) throws SQLException {
        String sql = switch (ebene) {
            case BerechnetePeriodenRepository.VIERTELSTUNDE -> "SELECT menge, menge_zustand, kennzeichen::text, "
                    + "abdeckung_prozent, zustand, berechnet_am FROM messreihe_viertelstunde WHERE tenant_id = ? "
                    + "AND messstelle_id = ? AND intervall_beginn = ?";
            case BerechnetePeriodenRepository.TAG -> "SELECT menge, menge_zustand, kennzeichen::text, abdeckung_prozent, "
                    + "zustand, berechnet_am FROM messreihe_tag WHERE tenant_id = ? AND messstelle_id = ? AND beginn = ?";
            default -> "SELECT menge, menge_zustand, kennzeichen::text, abdeckung_prozent, zustand, berechnet_am "
                    + "FROM messreihe_periode WHERE tenant_id = ? AND messstelle_id = ? AND beginn = ? AND art = '"
                    + ebene + "'";
        };
        try (PreparedStatement ps = con.prepareStatement(sql)) {
            ps.setObject(1, tenant);
            ps.setObject(2, messstelle);
            ps.setTimestamp(3, Timestamp.from(beginn));
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    return null;
                }
                return new Gespeichert(1, new Inhalt(null, rs.getBigDecimal(1), rs.getString(2),
                        ViertelstundenTeile.kennzeichen(rs.getString(3)), null, null, KaskadeStufen.ganz(rs, 4), null,
                        null, null, null, null, null, null, null, null, null, null, rs.getString(5)), List.of(),
                        List.of(), null, ViertelstundenTeile.zeit(rs, 6));
            }
        }
    }

    /**
     * Die Eingänge eines Terms in ihrer NEUESTEN Version: ein Messkanal über die Versionen seiner Reihe, eine gemessene
     * Messstelle über die Reihe ihrer führenden Bindung ({@link MessstelleWerteRegeln#deckung}, dieselbe Deckung wie das
     * Lese-Modell), eine berechnete über ihre eigenen Versionen. Das Kennzeichen „korrigiert (Version n)“ eines Eingangs
     * erbt nie — die berechnete Periode sagt ihre eigene Version.
     */
    private static Map<Instant, BerechnetePeriode.Eingang> ueberlagern(Connection con, UUID tenant,
            BerechnetePeriodenLauf.TermRef ref, String ebene, ZoneId zone, LocalDate von, LocalDate bis,
            Map<Instant, BerechnetePeriode.Eingang> gelesen, Map<String, List<String>> wirkt) {
        Map<Instant, BerechnetePeriode.Eingang> aus = new HashMap<>(gelesen);
        if (ref.grund() != null) {
            return aus;
        }
        Instant a = TagRegeln.beginn(von, zone);
        Instant b = TagRegeln.ende(bis, zone);
        try {
            if (ref.messstelleId() != null && (ref.berechnet() || ablesungsquelle(con, tenant, ref.messstelleId()))) {
                for (Versioniert v : versionen(con, tenant, null, null, ref.messstelleId(), ebene, a, b)) {
                    einsetzen(aus, v, ref.kennzeichen(), schluessel(ref.messstelleId(), null, null, ebene, v.beginn()),
                            wirkt);
                }
                return aus;
            }
            List<MessstelleWerteRegeln.Bindung> bindungen = ref.messstelleId() == null ? null
                    : fuehrend(con, tenant, ref.messstelleId());
            Set<MessstelleWerteRegeln.Reihe> reihen = new LinkedHashSet<>();
            if (bindungen == null) {
                reihen.add(new MessstelleWerteRegeln.Reihe(ref.entityId(), ref.messkanal()));
            } else {
                bindungen.forEach(x -> reihen.add(new MessstelleWerteRegeln.Reihe(x.entityId(), x.kanal())));
            }
            for (MessstelleWerteRegeln.Reihe reihe : reihen) {
                for (Versioniert v : versionen(con, tenant, reihe.entityId(), reihe.kanal(), null, ebene, a, b)) {
                    BerechnetePeriode.Eingang alt = aus.get(v.beginn());
                    if (alt != null && BerechnetePeriodenLauf.KEINE_MENGE.equals(alt.grund())) {
                        continue;
                    }
                    if (bindungen != null) {
                        MessstelleWerteRegeln.Deckung d = MessstelleWerteRegeln.deckung(bindungen,
                                new MessstelleWerteRegeln.Schritt(v.beginn(), v.ende()));
                        if (!reihe.equals(d.reihe())) {
                            continue;
                        }
                    }
                    einsetzen(aus, v, bindungen == null ? ref.messkanal() : ref.kennzeichen(),
                            schluessel(ref.messstelleId(), ref.entityId(), ref.messkanal(), ebene, v.beginn()), wirkt);
                }
            }
            return aus;
        } catch (SQLException e) {
            throw new IllegalStateException("UEMS Korrektur-Kaskade: Eingang " + ref.quelle() + " nicht lesbar", e);
        }
    }

    private record Versioniert(Instant beginn, Instant ende, int version, BigDecimal menge, String zustand,
            Integer abdeckung, List<String> kennzeichen, String fassung, List<String> wirkt) {}

    private static void einsetzen(Map<Instant, BerechnetePeriode.Eingang> aus, Versioniert v, String name,
            String schluessel, Map<String, List<String>> wirkt) {
        BerechnetePeriode.Eingang alt = aus.get(v.beginn());
        aus.put(v.beginn(), new BerechnetePeriode.Eingang(name, null, null, null, null, v.menge(), v.zustand(),
                v.abdeckung() != null ? v.abdeckung() : alt == null ? null : alt.abdeckungProzent(), v.version(),
                KaskadeStufen.ohneVersion(v.kennzeichen()),
                v.fassung() != null ? v.fassung() : alt != null && alt.fassung() != null ? alt.fassung()
                        : ViertelstundeRegeln.VORLAEUFIG,
                null));
        wirkt.put(schluessel, v.wirkt());
    }

    /** Die neuesten Versionen einer Reihe bzw. berechneten Messstelle auf einer Ebene in {@code [a, b)}. */
    private static List<Versioniert> versionen(Connection con, UUID tenant, UUID entity, String kanal, UUID messstelle,
            String ebene, Instant a, Instant b) throws SQLException {
        List<Versioniert> aus = new ArrayList<>();
        if (messstelle == null && BerechnetePeriodenRepository.VIERTELSTUNDE.equals(ebene)) {
            try (PreparedStatement ps = con.prepareStatement("""
                    SELECT DISTINCT ON (intervall_beginn) intervall_beginn, version, menge, menge_zustand, abdeckung_prozent,
                           kennzeichen::text, korrekturen, ersatzwerte
                      FROM messreihe_viertelstunde_version
                     WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? AND intervall_beginn >= ? AND intervall_beginn < ?
                     ORDER BY intervall_beginn, version DESC
                    """)) {
                ps.setObject(1, tenant);
                ps.setObject(2, entity);
                ps.setString(3, kanal);
                ps.setTimestamp(4, Timestamp.from(a));
                ps.setTimestamp(5, Timestamp.from(b));
                try (ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) {
                        Instant q = ViertelstundenTeile.zeit(rs, 1);
                        List<String> wirkt = new ArrayList<>();
                        List<String> k = KaskadeStufen.texte(rs.getArray(7));
                        if (k != null) {
                            wirkt.addAll(k);
                        }
                        wirkt.addAll(KaskadeStufen.texte(rs.getArray(8)));
                        aus.add(new Versioniert(q, q.plus(KaskadeStufen.VIERTELSTUNDE), rs.getInt(2), rs.getBigDecimal(3),
                                rs.getString(4), KaskadeStufen.ganz(rs, 5),
                                ViertelstundenTeile.kennzeichen(rs.getString(6)), null, wirkt));
                    }
                }
            }
            return aus;
        }
        String spur = messstelle == null ? "messstelle_id IS NULL AND entity_id = ? AND messkanal = ?" : "messstelle_id = ?";
        try (PreparedStatement ps = con.prepareStatement("SELECT DISTINCT ON (periode_beginn) periode_beginn, periode_ende, "
                + "version, menge, menge_zustand, abdeckung_prozent, kennzeichen::text, zustand, korrekturen, ersatzwerte "
                + "FROM messreihe_periode_version WHERE tenant_id = ? AND " + spur + " AND ebene = ? "
                + "AND periode_beginn >= ? AND periode_beginn < ? ORDER BY periode_beginn, version DESC")) {
            int p = 1;
            ps.setObject(p++, tenant);
            if (messstelle == null) {
                ps.setObject(p++, entity);
                ps.setString(p++, kanal);
            } else {
                ps.setObject(p++, messstelle);
            }
            ps.setString(p++, ebene);
            ps.setTimestamp(p++, Timestamp.from(a));
            ps.setTimestamp(p, Timestamp.from(b));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    List<String> wirkt = new ArrayList<>(KaskadeStufen.texte(rs.getArray(9)));
                    wirkt.addAll(KaskadeStufen.texte(rs.getArray(10)));
                    aus.add(new Versioniert(ViertelstundenTeile.zeit(rs, 1), ViertelstundenTeile.zeit(rs, 2), rs.getInt(3),
                            rs.getBigDecimal(4), rs.getString(5), KaskadeStufen.ganz(rs, 6),
                            ViertelstundenTeile.kennzeichen(rs.getString(7)), rs.getString(8), wirkt));
                }
            }
        }
        return aus;
    }

    private static boolean ablesungsquelle(Connection con, UUID tenant, UUID messstelle) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("SELECT EXISTS (SELECT 1 FROM messstelle_quelle "
                + "WHERE tenant_id=? AND messstelle_id=? AND entity_id IS NULL)")) {
            ps.setObject(1, tenant);
            ps.setObject(2, messstelle);
            try (ResultSet rs = ps.executeQuery()) { rs.next(); return rs.getBoolean(1); }
        }
    }

    /** Die führenden Bindungen der Hauptgröße einer gemessenen Messstelle — wie das Lese-Modell sie filtert. */
    private static List<MessstelleWerteRegeln.Bindung> fuehrend(Connection con, UUID tenant, UUID messstelle)
            throws SQLException {
        List<MessstelleWerteRegeln.Bindung> aus = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT q.id, q.entity_id, q.kanal, q.herleitung, q.anteil, q.gueltig_ab, q.gueltig_bis
                  FROM messstelle_quelle q JOIN messstelle m ON m.id = q.messstelle_id
                 WHERE q.tenant_id = ? AND q.messstelle_id = ? AND q.rolle = 'fuehrend'
                   AND q.groesse = m.groesse AND q.richtung = m.richtung
                 ORDER BY q.gueltig_ab, q.id
                """)) {
            ps.setObject(1, tenant);
            ps.setObject(2, messstelle);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.add(new MessstelleWerteRegeln.Bindung(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class),
                            rs.getString(3), rs.getString(4), rs.getString(5), ViertelstundenTeile.zeit(rs, 6),
                            ViertelstundenTeile.zeit(rs, 7)));
                }
            }
        }
        return aus;
    }

    private static String schluessel(UUID messstelle, UUID entity, String kanal, String ebene, Instant beginn) {
        return messstelle + "|" + entity + "|" + kanal + "|" + ebene + "|" + beginn;
    }

    // ============================================================================ Der Nachzug

    /**
     * Zieht EINE vorläufige Periode nach, deren Version 1 seit ihrer neuesten Version neu gebildet wurde: nur diese
     * Stufe, unter derselben Nummer. Die gröberen Stufen haben ihre eigene Version 1, die die Verdichtung dann ebenfalls
     * neu bildet — und werden so selbst gefunden. {@code null} ohne Arbeit.
     */
    private Zug nachziehen(Connection con, Instant jetzt) throws SQLException {
        record Kandidat(UUID tenant, UUID entity, String kanal, UUID messstelle, String ebene, Instant beginn,
                LocalDate tag, String zone, int version, String anlass, int fassung) {}
        List<Kandidat> kandidaten = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT v.tenant_id, v.entity_id, v.messkanal, v.messstelle_id, v.ebene, v.periode_beginn, v.tag,
                       v.zeitzone, v.version, v.anlass_kennung, v.anlass_fassung
                  FROM (SELECT DISTINCT ON (tenant_id, ebene, entity_id, messkanal, messstelle_id, periode_beginn) *
                          FROM messreihe_periode_version
                         ORDER BY tenant_id, ebene, entity_id, messkanal, messstelle_id, periode_beginn, version DESC) v
                 WHERE v.zustand = 'vorlaeufig' AND (
                       EXISTS (SELECT 1 FROM messreihe_tag t WHERE v.ebene = 'tag' AND t.tenant_id = v.tenant_id
                                  AND t.entity_id IS NOT DISTINCT FROM v.entity_id
                                  AND t.messkanal IS NOT DISTINCT FROM v.messkanal
                                  AND t.messstelle_id IS NOT DISTINCT FROM v.messstelle_id AND t.beginn = v.periode_beginn
                                  AND t.berechnet_am > coalesce(v.basis_berechnet_am, '-infinity'))
                    OR EXISTS (SELECT 1 FROM messreihe_periode m WHERE v.ebene IN ('monat', 'jahr') AND m.art = v.ebene
                                  AND m.tenant_id = v.tenant_id AND m.entity_id IS NOT DISTINCT FROM v.entity_id
                                  AND m.messkanal IS NOT DISTINCT FROM v.messkanal
                                  AND m.messstelle_id IS NOT DISTINCT FROM v.messstelle_id AND m.beginn = v.periode_beginn
                                  AND m.berechnet_am > coalesce(v.basis_berechnet_am, '-infinity'))
                    OR EXISTS (SELECT 1 FROM messreihe_viertelstunde q WHERE v.ebene = 'viertelstunde'
                                  AND q.tenant_id = v.tenant_id AND q.messstelle_id = v.messstelle_id
                                  AND q.intervall_beginn = v.periode_beginn
                                  AND q.berechnet_am > coalesce(v.basis_berechnet_am, '-infinity')))
                 ORDER BY v.periode_beginn LIMIT 20
                """); ResultSet rs = ps.executeQuery()) {
            while (rs.next()) {
                kandidaten.add(new Kandidat(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3),
                        rs.getObject(4, UUID.class), rs.getString(5), ViertelstundenTeile.zeit(rs, 6),
                        rs.getObject(7, LocalDate.class), rs.getString(8), rs.getInt(9), rs.getString(10),
                        rs.getInt(11)));
            }
        }
        for (Kandidat c : kandidaten) {
            if (!sperre(con, "uems-kaskade:" + c.tenant(), false)) {
                continue;
            }
            int n;
            Instant basis;
            List<BerechnetePeriode.Abgelehnt> kreise = List.of();
            if (c.messstelle() == null) {
                KaskadeStufen.Reihe r = new KaskadeStufen.Reihe(c.tenant(), c.entity(), c.kanal());
                n = stufe(con, c.anlass(), c.fassung(), r, c.ebene(), c.tag(), TagRegeln.zone(c.zone()), jetzt,
                        Modus.NACHZUG);
                Gespeichert v1 = KaskadeStufen.bestand(con, r, c.ebene(), c.tag());
                basis = v1 == null ? null : v1.basisBerechnetAm();
            } else {
                ZoneId zone = berechnete.zoneDesKundenbereichs(c.tenant());
                LocalDate von = TagRegeln.tag(c.beginn(), zone);
                LocalDate bis = switch (c.ebene()) {
                    case KaskadeStufen.MONAT -> von.plusMonths(1).minusDays(1);
                    case KaskadeStufen.JAHR -> von.plusYears(1).minusDays(1);
                    default -> von;
                };
                Berechnet b = berechneteStufen(con, c.tenant(), c.anlass(), c.fassung(), von, bis, Set.of(c.ebene()),
                        jetzt, Modus.NACHZUG);
                n = b.versionen();
                kreise = b.kreise();
                Gespeichert v1 = berechneterBestand(con, c.tenant(), c.messstelle(), c.ebene(), c.beginn());
                basis = v1 == null ? null : v1.basisBerechnetAm();
            }
            // Auch ohne Unterschied: die Grundlage ist gesehen — sonst fände die nächste Suche sie wieder.
            basisGesehen(con, c.tenant(), c.entity(), c.kanal(), c.messstelle(), c.ebene(), c.beginn(), c.version(), basis);
            return new Zug(0, 0, n, Map.of(), kreise);
        }
        return null;
    }

    private static void basisGesehen(Connection con, UUID tenant, UUID entity, String kanal, UUID messstelle,
            String ebene, Instant beginn, int version, Instant basis) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("UPDATE messreihe_periode_version SET basis_berechnet_am = ?, "
                + "nachgezogen_am = now() WHERE tenant_id = ? AND entity_id IS NOT DISTINCT FROM ? "
                + "AND messkanal IS NOT DISTINCT FROM ? AND messstelle_id IS NOT DISTINCT FROM ? AND ebene = ? "
                + "AND periode_beginn = ? AND version = ? AND zustand = 'vorlaeufig' "
                + "AND basis_berechnet_am IS DISTINCT FROM ?")) {
            Timestamp b = basis == null ? null : Timestamp.from(basis);
            ps.setTimestamp(1, b);
            ps.setObject(2, tenant);
            ps.setObject(3, entity, java.sql.Types.OTHER);
            ps.setString(4, kanal);
            ps.setObject(5, messstelle, java.sql.Types.OTHER);
            ps.setString(6, ebene);
            ps.setTimestamp(7, Timestamp.from(beginn));
            ps.setInt(8, version);
            ps.setTimestamp(9, b);
            ps.executeUpdate();
        }
    }

    // ============================================================================ Die Meldung correction

    /**
     * Die Meldung {@code correction} je Reihe und Entscheidung — der Revisions-Auslöser für AP-12. Urheber ist der
     * Kunde: entschieden hat ein Mensch; die Kaskade meldet es nur, in derselben Transaktion wie die Versionen (die Cloud
     * darf nur {@code vorschlag} melden). Die Kennung ist abgeleitet: eine Wiederholung schreibt nichts.
     */
    private static UUID correction(Connection con, UUID tenant, Korrektur k, String status, Reihe r, Instant jetzt)
            throws SQLException {
        UUID id = UUID.nameUUIDFromBytes(("correction:" + tenant + ":" + k.kennung() + ":" + status + ":" + r.entity()
                + ":" + r.kanal()).getBytes(StandardCharsets.UTF_8));
        ObjectNode e = JSON.createObjectNode();
        e.put("ereignis_id", id.toString());
        e.put("art", "correction");
        e.put("von", k.von().truncatedTo(ChronoUnit.SECONDS).toString());
        e.put("bis", k.bis().truncatedTo(ChronoUnit.SECONDS).toString());
        e.put("komponente", r.entity().toString());
        e.put("messkanal", r.kanal());
        e.put("korrektur", k.kennung());
        e.put("korrektur_art", k.art());
        if (k.ersatzwert() != null) e.put("ersatzwert", k.ersatzwert());
        e.put("status", status);
        Urteil urteil = EreignisVokabular.pruefe(e, Urheber.KUNDE);
        if (!urteil.angenommen()) {
            throw new IllegalStateException("correction-Meldung verworfen: " + urteil.grund() + " " + urteil.hinweis());
        }
        ObjectNode kennungen = JSON.createObjectNode().put("komponente", r.entity().toString());
        ObjectNode nutzlast = JSON.createObjectNode().put("korrektur", k.kennung()).put("korrektur_art", k.art())
                .put("status", status);
        if (k.ersatzwert() != null) nutzlast.put("ersatzwert", k.ersatzwert());
        try (PreparedStatement ps = con.prepareStatement("""
                INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, von, bis, kennungen,
                       entity_id, messkanal, nutzlast, eingang)
                VALUES (?, ?, ?, 'correction', 'kunde', ?, ?, ?::jsonb, ?, ?, ?::jsonb, ?)
                ON CONFLICT DO NOTHING
                """)) {
            ps.setTimestamp(1, Timestamp.from(k.von()));
            ps.setObject(2, tenant);
            ps.setObject(3, id);
            ps.setTimestamp(4, Timestamp.from(k.von()));
            ps.setTimestamp(5, Timestamp.from(k.bis()));
            ps.setString(6, kennungen.toString());
            ps.setObject(7, r.entity());
            ps.setString(8, r.kanal());
            ps.setString(9, nutzlast.toString());
            ps.setTimestamp(10, Timestamp.from(jetzt));
            ps.executeUpdate();
        }
        return id;
    }

    // ============================================================================ Laden

    private static Korrektur korrektur(Connection con, UUID tenant, String kennung) throws SQLException {
        String art = null;
        List<Reihe> reihen = new ArrayList<>();
        Instant von = null;
        Instant bis = null;
        JsonNode vorschau = null;
        String ersatzwert = null;
        List<Entscheidung> entscheidungen = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("SELECT fassung, status, art, reihen::text, von, bis, "
                + "vorschau::text, ersatzwert_kennung FROM messreihe_korrektur WHERE tenant_id = ? AND kennung = ? ORDER BY fassung")) {
            ps.setObject(1, tenant);
            ps.setString(2, kennung);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    if (rs.getInt(1) == 1) {
                        art = rs.getString(3);
                        for (JsonNode n : JSON.readTree(rs.getString(4))) {
                            if (n.has("messstelle_id")) continue;
                            reihen.add(new Reihe(UUID.fromString(n.path("entity_id").asText()),
                                    n.path("messkanal").asText()));
                        }
                        von = ViertelstundenTeile.zeit(rs, 5);
                        bis = ViertelstundenTeile.zeit(rs, 6);
                        vorschau = JSON.readTree(rs.getString(7));
                        ersatzwert = rs.getString(8);
                    } else if (FREIGEGEBEN.equals(rs.getString(2)) || ZURUECKGENOMMEN.equals(rs.getString(2))) {
                        entscheidungen.add(new Entscheidung(rs.getInt(1), rs.getString(2)));
                    }
                }
            }
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new IllegalStateException("Korrektur " + kennung + " nicht lesbar", e);
        }
        return new Korrektur(kennung, art, List.copyOf(reihen), von, bis, vorschau, List.copyOf(entscheidungen), ersatzwert);
    }

    /** Die Vorschau „neu“ je Viertelstunde — älteste zuerst. */
    private static Map<Instant, KorrekturVorschlagRegeln.Stand> vorschau(JsonNode vorschau) {
        TreeMap<Instant, KorrekturVorschlagRegeln.Stand> aus = new TreeMap<>();
        if (vorschau == null || !vorschau.isArray()) {
            return aus;
        }
        for (JsonNode p : vorschau) {
            if (!KorrekturVorschlagRegeln.VIERTELSTUNDE.equals(p.path("periode").asText()) || !p.has("neu")) {
                continue;
            }
            JsonNode n = p.path("neu");
            List<String> kennzeichen = new ArrayList<>();
            n.path("kennzeichen").forEach(x -> kennzeichen.add(x.asText()));
            aus.put(Instant.parse(p.path("von").asText()), new KorrekturVorschlagRegeln.Stand(null, dezimal(n, "menge"),
                    n.path("menge_zustand").asText(null), kennzeichen, ganz(n, "erhalten"), ganz(n, "erwartet"),
                    ganz(n, "abdeckung_prozent"), dezimal(n, "mittel"), dezimal(n, "energie")));
        }
        return aus;
    }

    private static Reihe ersatzwertReihe(Connection con, UUID tenant, String kennung) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("SELECT entity_id, messkanal FROM messreihe_ersatzwert "
                + "WHERE tenant_id = ? AND kennung = ? AND fassung = 1")) {
            ps.setObject(1, tenant);
            ps.setString(2, kennung);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return new Reihe(rs.getObject(1, UUID.class), rs.getString(2));
            }
        }
    }

    private static Instant[] ersatzwertZeitraum(Connection con, UUID tenant, String kennung) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("SELECT von, bis FROM messreihe_ersatzwert "
                + "WHERE tenant_id = ? AND kennung = ? AND fassung = 1")) {
            ps.setObject(1, tenant);
            ps.setString(2, kennung);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return new Instant[] {ViertelstundenTeile.zeit(rs, 1), ViertelstundenTeile.zeit(rs, 2)};
            }
        }
    }

    private static Map<Instant, Instant> viertelBerechnetAm(Connection con, KaskadeStufen.Reihe r, Instant von,
            Instant bis) throws SQLException {
        Map<Instant, Instant> aus = new HashMap<>();
        try (PreparedStatement ps = con.prepareStatement("SELECT intervall_beginn, berechnet_am FROM messreihe_viertelstunde "
                + "WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? AND intervall_beginn >= ? AND intervall_beginn < ?")) {
            ps.setObject(1, r.tenant());
            ps.setObject(2, r.entity());
            ps.setString(3, r.kanal());
            ps.setTimestamp(4, Timestamp.from(von));
            ps.setTimestamp(5, Timestamp.from(bis));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.put(ViertelstundenTeile.zeit(rs, 1), ViertelstundenTeile.zeit(rs, 2));
                }
            }
        }
        return aus;
    }

    // ============================================================================ Wirkung, Sperre, Transaktion

    private static int wirkungFassung(Connection con, UUID tenant, String kennung) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement(
                "SELECT fassung FROM messreihe_kaskade_wirkung WHERE tenant_id = ? AND anlass_kennung = ?")) {
            ps.setObject(1, tenant);
            ps.setString(2, kennung);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? rs.getInt(1) : 0;
            }
        }
    }

    private static void wirkung(Connection con, Anlass a, String ergebnis, int versionen, Instant jetzt)
            throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("""
                INSERT INTO messreihe_kaskade_wirkung (tenant_id, anlass_kennung, fassung, ergebnis, versionen, berechnet_am)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (tenant_id, anlass_kennung) DO UPDATE
                   SET fassung = EXCLUDED.fassung, ergebnis = EXCLUDED.ergebnis, versionen = EXCLUDED.versionen,
                       berechnet_am = EXCLUDED.berechnet_am
                """)) {
            ps.setObject(1, a.tenant());
            ps.setString(2, a.kennung());
            ps.setInt(3, a.fassung());
            ps.setString(4, ergebnis);
            ps.setInt(5, versionen);
            ps.setTimestamp(6, Timestamp.from(jetzt));
            ps.executeUpdate();
        }
    }

    private static boolean sperre(Connection con, String schluessel, boolean warten) throws SQLException {
        String sql = warten ? "SELECT true FROM pg_advisory_xact_lock(hashtextextended(?, 0))"
                : "SELECT pg_try_advisory_xact_lock(hashtextextended(?, 0))";
        try (PreparedStatement ps = con.prepareStatement(sql)) {
            ps.setString(1, schluessel);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getBoolean(1);
            }
        }
    }

    @FunctionalInterface
    private interface Schritt<T> {
        T fahren(Connection con) throws SQLException;
    }

    private <T> T inTransaktion(Schritt<T> schritt) {
        return adminJdbc.execute((Connection con) -> {
            boolean autoCommit = con.getAutoCommit();
            con.setAutoCommit(false);
            try {
                T ergebnis = schritt.fahren(con);
                con.commit();
                return ergebnis;
            } catch (Exception e) {
                con.rollback();
                throw e instanceof SQLException sql ? sql : new SQLException("UEMS Korrektur-Kaskade fehlgeschlagen", e);
            } finally {
                con.setAutoCommit(autoCommit);
            }
        });
    }

    // ============================================================================ Hilfen

    private static Inhalt leererInhalt() {
        return new Inhalt(null, null, VerbrauchRegeln.KEINE_WERTE, List.of(), 0, 0, null, null, null, null, null, null,
                null, null, null, null, null, null, null);
    }

    private static String zustand(String gespeichert) {
        return gespeichert == null ? VerbrauchRegeln.KEINE_WERTE : gespeichert;
    }

    private static VerbrauchRegeln.Rohwert rohwert(Map<String, Object> z, String spalte) {
        return rohwert(z, spalte, spalte + "_zeit");
    }

    private static VerbrauchRegeln.Rohwert rohwert(Map<String, Object> z, String wert, String zeit) {
        Object w = z.get(wert);
        Object t = z.get(zeit);
        if (w == null || t == null) {
            return null;
        }
        Instant i = t instanceof Timestamp ts ? ts.toInstant() : (Instant) t;
        return new VerbrauchRegeln.Rohwert(i, (BigDecimal) w);
    }

    private static BigDecimal dezimal(JsonNode n, String feld) {
        JsonNode x = n.path(feld);
        return x.isNull() || x.isMissingNode() ? null : new BigDecimal(x.asText());
    }

    private static Integer ganz(JsonNode n, String feld) {
        JsonNode x = n.path(feld);
        return x.isNull() || x.isMissingNode() ? null : x.asInt();
    }
}
