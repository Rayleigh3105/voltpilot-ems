package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.web.dto.BezugsbasisVergleichDto;
import java.math.BigDecimal;
import java.sql.Date;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Der Abzug der Vorlage {@code leistungsvergleich} (UEMS AP-17 IP-21b, S1–S4, E7 = A, E8 = A): eine Kennzahl mit der
 * Bezugsbasis-Fassung, die am LETZTEN Tag der Berichtsperiode gilt (P4), und dem Vergleich je Periode aus dem EINEN
 * Leser {@link BezugsbasisVergleich} (IP-19). Gerechnet wird hier nichts — erwartet, Δ, Band, Urteil und Kennzeichen
 * stehen, wie der Leser sie liefert; die Fassung (Methode, Basiswert/Koeffizienten, Güte, Toleranz, Referenzperiode)
 * und ihre statischen Faktoren sind die eingefrorene Kopie der Fassung.
 *
 * <p>Abschnitte in der Folge der Vorlage (bericht-vorlagen.json): {@code kopf} · {@code kennzahl} · {@code bezugsbasis} ·
 * {@code vergleich_je_periode} · {@code urteil} · {@code grenzen_und_vorbehalte} · {@code statische_faktoren}; das
 * Quellenverzeichnis steht wie bei jeder Vorlage in {@code kopf.quellenverzeichnis} (Kennzahl und Messstellen mit
 * Version, Bezugsgrößen mit Fassung, die Bezugsbasis mit Fassung und {@code bezug = vergleich}).
 *
 * <p>Ohne freigegebene Fassung am letzten Tag gibt es keinen Entwurf: {@code 422 basis_fehlt} („ungesichert — noch kein
 * Stand“). Ein Urteil gibt es nur bereinigt; die rohe Veränderung trägt nie eins (U1, VG3).
 */
final class BerichtLeistungsvergleich {

    static final List<String> ABSCHNITTE = List.of("kopf", "kennzahl", "bezugsbasis", "vergleich_je_periode", "urteil",
            "grenzen_und_vorbehalte", "statische_faktoren");

    private static final String BEZUGSBASIS = "bezugsbasis";
    private static final String BEZUGSGROESSE = "bezugsgroesse";
    private static final String KENNZAHL = "kennzahl";
    private static final String MESSSTELLE = "messstelle";

    /** Die freigegebene Fassung am letzten Tag der Berichtsperiode, wie gespeichert (M4: eingefrorene Kopie). */
    record Fassung(UUID basisId, String basis, UUID fassungId, int fassung, String methode, String referenzperiode,
            String datenlage, LocalDate giltAb, LocalDate giltBis, BigDecimal basiswert, String koeffizienten,
            BigDecimal r2, BigDecimal streuungProzent, BigDecimal toleranzProzent, String pruefsumme,
            String freigabeName, String freigabeRolle, Instant freigabeAm) {}

    /** Ein statischer Faktor der Fassung (V3), Wert zum Freigabetag als Kopie. */
    record Faktor(int position, String art, String kennzeichen, String wortlaut, BigDecimal wert, String einheit,
            LocalDate wertGueltigAb, LocalDate kopieAm) {}

    /** Ein Eingang eines Monatswerts der Kennzahl mit Version bzw. Fassung (für das Quellenverzeichnis). */
    record Eingang(String art, String kennzeichen, UUID objekt, String name, Integer version, Integer fassung,
            LocalDate ersterTag, LocalDate letzterTag) {}

    /** Kopf-Angaben, die der Aufrufer liest. */
    record Kopf(String kennung, BerichtAbzugBildung.Geltung geltung, BerichtRegeln.Zeitraum zeitraum, ZoneId zone,
            Instant datenstand, BerichtRegelwerk regelwerk) {}

    record Ergebnis(ObjectNode abzug, List<BerichtAbzugBildung.Quelle> quellen, List<Instant> zeiten) {}

    private BerichtLeistungsvergleich() {}

    // ================================================================================ lesen

    /** P4 — die freigegebene Fassung der Basis dieser Kennzahl, die am Tag gilt; leer: keine. */
    static java.util.Optional<Fassung> fassungAm(JdbcTemplate j, UUID tenant, UUID kennzahl, LocalDate tag) {
        return j.query("""
                SELECT b.id AS basis_id, b.kennzeichen, f.id AS fassung_id, f.fassung, f.methode, f.referenzperiode,
                       f.datenlage, f.gilt_ab, f.gilt_bis, f.basiswert, f.koeffizienten::text AS koeffizienten, f.r2,
                       f.streuung_prozent, f.toleranz_prozent, f.pruefsumme, f.freigabe_name, f.freigabe_rolle, f.freigabe_am
                  FROM bezugsbasis b
                  JOIN bezugsbasis_fassung f ON f.bezugsbasis_id = b.id AND f.tenant_id = b.tenant_id
                 WHERE b.tenant_id = ? AND b.kennzahl_id = ? AND f.freigabe_status = 'freigegeben'
                   AND f.gilt_ab <= ? AND (f.gilt_bis IS NULL OR f.gilt_bis >= ?)
                 ORDER BY f.fassung DESC LIMIT 1
                """, (rs, i) -> {
                    Date bis = rs.getDate("gilt_bis");
                    java.sql.Timestamp am = rs.getTimestamp("freigabe_am");
                    return new Fassung(rs.getObject("basis_id", UUID.class), rs.getString("kennzeichen"),
                            rs.getObject("fassung_id", UUID.class), rs.getInt("fassung"), rs.getString("methode"),
                            rs.getString("referenzperiode"), rs.getString("datenlage"),
                            rs.getDate("gilt_ab").toLocalDate(), bis == null ? null : bis.toLocalDate(),
                            rs.getBigDecimal("basiswert"), rs.getString("koeffizienten"), rs.getBigDecimal("r2"),
                            rs.getBigDecimal("streuung_prozent"), rs.getBigDecimal("toleranz_prozent"),
                            rs.getString("pruefsumme"), rs.getString("freigabe_name"),
                            rs.getString("freigabe_rolle"), am == null ? null : am.toInstant());
                }, tenant, kennzahl, Date.valueOf(tag), Date.valueOf(tag)).stream().findFirst();
    }

    /** V3 — die statischen Faktoren der Fassung (IP-16b; bis dahin aus {@code bezugsbasis_faktor} gelesen). */
    static List<Faktor> faktoren(JdbcTemplate j, UUID tenant, UUID fassung) {
        return j.query("""
                SELECT f.position, f.art, f.wortlaut, f.wert, f.einheit, f.wert_gueltig_ab, f.kopie_am,
                       coalesce(o.kurzzeichen, s.kurzzeichen, f.verweis::text) AS kennzeichen
                  FROM bezugsbasis_faktor f
                  LEFT JOIN ort o ON o.id = f.verweis AND o.tenant_id = f.tenant_id
                  LEFT JOIN standort s ON s.id = f.verweis AND s.tenant_id = f.tenant_id
                 WHERE f.tenant_id = ? AND f.fassung_id = ? AND f.aufgehoben_am IS NULL
                 ORDER BY f.position
                """, (rs, i) -> new Faktor(rs.getInt("position"), rs.getString("art"),
                        "wortlaut".equals(rs.getString("art")) ? null : rs.getString("kennzeichen"),
                        rs.getString("wortlaut"), rs.getBigDecimal("wert"), rs.getString("einheit"),
                        rs.getObject("wert_gueltig_ab", LocalDate.class), rs.getObject("kopie_am", LocalDate.class)),
                tenant, fassung);
    }

    /**
     * Die Eingänge der gespeicherten Monatswerte der Kennzahl ({@code kennzahl_wert_eingang}, neueste Version je
     * Monat) — Messstellen mit Version, Bezugsgrößen mit Fassung. Ohne gespeicherten Wert kein Eingang.
     */
    static List<Eingang> eingaenge(JdbcTemplate j, UUID tenant, UUID kennzahl, YearMonth von, YearMonth bis) {
        List<Eingang> aus = new ArrayList<>();
        for (YearMonth m = von; !m.isAfter(bis); m = m.plusMonths(1)) {
            LocalDate erster = m.atDay(1), letzter = m.atEndOfMonth();
            KennzahlWerteLeser.Zeile w = KennzahlWerteService.waehle(
                    new KennzahlWerteLeser(j).zeilen(kennzahl, "monat", erster, erster), null);
            if (w == null || w.version() == null) {
                continue;
            }
            j.query("""
                    SELECT e.art, coalesce(m.kennzeichen, b.kennzeichen, k.kennzeichen, e.objekt) AS kennzeichen,
                           coalesce(e.messstelle_id, e.bezugsgroesse_id, e.eingang_kennzahl_id) AS objekt_id,
                           coalesce(m.name, b.name, k.name) AS name, e.version, e.fassung
                      FROM kennzahl_wert_eingang e
                      LEFT JOIN messstelle m ON m.id = e.messstelle_id AND m.tenant_id = e.tenant_id
                      LEFT JOIN bezugsgroesse b ON b.id = e.bezugsgroesse_id AND b.tenant_id = e.tenant_id
                      LEFT JOIN kennzahl k ON k.id = e.eingang_kennzahl_id AND k.tenant_id = e.tenant_id
                     WHERE e.tenant_id = ? AND e.wert_id = ? ORDER BY e.position
                    """, rs -> {
                        String art = rs.getString("art");
                        UUID objekt = rs.getObject("objekt_id", UUID.class);
                        if (objekt == null) {
                            return;
                        }
                        aus.add(new Eingang(art, rs.getString("kennzeichen"), objekt, rs.getString("name"),
                                BEZUGSGROESSE.equals(art) ? null : rs.getObject("version", Integer.class),
                                BEZUGSGROESSE.equals(art) ? rs.getObject("fassung", Integer.class) : null, erster,
                                letzter));
                    }, tenant, w.id());
        }
        return aus;
    }

    // ================================================================================ bilden (rein)

    /**
     * Bildet den Abzug aus dem Vergleich, der Fassung, ihren Faktoren und den Eingängen. Rein: gleiche Eingänge, gleicher
     * Abzug (und damit dieselbe Prüfsumme).
     */
    static Ergebnis abzug(ObjectMapper json, Kopf k, BezugsbasisVergleichDto.Vergleich v, Fassung f,
            List<Faktor> faktoren, List<Eingang> eingaenge, Map<String, UUID> bezugsgroessen) {
        BerichtRegeln.Zeitraum z = k.zeitraum();
        ZoneId zone = k.zone();
        List<BerichtAbzugBildung.Quelle> quellen = new ArrayList<>();
        ObjectNode abzug = json.createObjectNode();

        // ---------------------------------------------------------------- Kopf
        ObjectNode kopf = abzug.putObject("kopf");
        kopf.put("bericht", k.kennung());
        kopf.put("vorlage", BerichtRegeln.LEISTUNGSVERGLEICH);
        kopf.put("vorlage_fassung", 1);
        ObjectNode geltung = kopf.putObject("geltung");
        geltung.put("art", k.geltung().art());
        geltung.put("kennzeichen", k.geltung().kennzeichen());
        geltung.put("name_zum_datenstand", k.geltung().name());
        kopf.put("unternehmen", k.geltung().unternehmen());
        kopf.put("sitz", k.geltung().sitz());
        ObjectNode zeitraum = kopf.putObject("zeitraum");
        zeitraum.put("art", z.art());
        zeitraum.put("schluessel", z.schluessel());
        zeitraum.put("von", BerichtAbzugBildung.iso(z.von(), zone));
        zeitraum.put("bis", BerichtAbzugBildung.iso(z.bis(), zone));
        zeitraum.put("zone", zone.getId());
        kopf.putArray("vergleichszeitraeume");
        // W8: das Zeitraum-Paar — Berichtsperiode (oben) und Referenzperiode der zitierten Fassung (Regel `zeitraum`).
        ObjectNode referenz = kopf.putObject("referenzperiode");
        referenz.put("schluessel", f.referenzperiode());
        referenz.put("bezeichnung", referenzBezeichnung(f.referenzperiode(), zone));
        ObjectNode zitiert = kopf.putObject("bezugsbasis");
        zitiert.put("kennzeichen", f.basis());
        zitiert.put("fassung", f.fassung());
        kopf.put("grenz_satz", BerichtRegeln.BEWERTUNG_GRENZ_SATZ);
        ArrayNode kopfZeichen = kopf.putArray("kennzeichen");
        kennzeichenDes(v).forEach(kopfZeichen::add);
        kopf.put("datenstand", BerichtAbzugBildung.iso(k.datenstand(), zone));
        ObjectNode rw = kopf.putObject("regelwerk");
        rw.put("software", k.regelwerk().software());
        ObjectNode vertraege = rw.putObject("vertraege");
        k.regelwerk().vertraege().forEach(vertraege::put);
        ObjectNode darstellung = kopf.putObject("darstellung");
        darstellung.put("zeitzone", zone.getId());
        darstellung.put("zahlenformat", BerichtAbzugBildung.ZAHLENFORMAT);
        darstellung.put("dezimal", BerichtAbzugBildung.DEZIMAL);
        darstellung.put("rundung", BerichtAbzugBildung.RUNDUNG);
        darstellung.put("sommerzeit", BerichtAbzugBildung.SOMMERZEIT);

        // ---------------------------------------------------------------- Kennzahl
        ObjectNode kennzahl = abzug.putObject("kennzahl");
        kennzahl.put("id", v.kennzahl().id().toString());
        kennzahl.put("kennzeichen", v.kennzahl().kennzeichen());
        kennzahl.put("name_zum_datenstand", v.kennzahl().name());
        kennzahl.put("rechenform", v.kennzahl().rechenform());
        kennzahl.put("einheit", v.kennzahl().einheit());

        // ---------------------------------------------------------------- Bezugsbasis (Fassung, eingefroren)
        ObjectNode basis = abzug.putObject("bezugsbasis");
        basis.put("id", f.basisId().toString());
        basis.put("kennzeichen", f.basis());
        basis.put("fassung", f.fassung());
        basis.put("methode", f.methode());
        basis.put("referenzperiode", f.referenzperiode());
        basis.put("datenlage", f.datenlage());
        basis.put("gilt_ab", f.giltAb().toString());
        basis.put("gilt_bis", f.giltBis() == null ? null : f.giltBis().toString());
        basis.put("basiswert", text(f.basiswert()));
        basis.set("koeffizienten", koeffizienten(json, f.koeffizienten()));
        basis.put("r2", text(f.r2()));
        basis.put("streuung_prozent", text(f.streuungProzent()));
        basis.put("toleranz_prozent", text(f.toleranzProzent()));
        basis.put("pruefsumme", f.pruefsumme());
        basis.put("freigegeben_von", f.freigabeName());
        basis.put("freigegeben_rolle", f.freigabeRolle());
        basis.put("freigegeben_am", f.freigabeAm() == null ? null : BerichtAbzugBildung.iso(f.freigabeAm(), zone));
        if (v.bezugsbasis() != null && v.bezugsbasis().beendetZum() != null) {
            // S4: ein Beenden ist im nächsten Entwurf ein Vermerk (die Fassung bleibt, nie gelöscht).
            basis.put("beendet_zum", v.bezugsbasis().beendetZum().toString());
            basis.put("beendet_grund", v.bezugsbasis().beendetGrund());
        }

        // ---------------------------------------------------------------- Vergleich je Periode, Urteil
        ArrayNode perioden = abzug.putArray("vergleich_je_periode");
        v.monate().forEach(m -> perioden.add(json.valueToTree(m)));
        abzug.set("urteil", json.valueToTree(v.zeitraum()));

        // ---------------------------------------------------------------- Grenzen und Vorbehalte
        ObjectNode grenzen = abzug.putObject("grenzen_und_vorbehalte");
        grenzen.put("datenlage", f.datenlage());
        grenzen.put("toleranz_prozent", text(f.toleranzProzent()));
        grenzen.put("streuung_prozent", text(f.streuungProzent()));
        ArrayNode zeichen = grenzen.putArray("kennzeichen");
        kennzeichenDes(v).forEach(zeichen::add);
        ArrayNode gruende = grenzen.putArray("nicht_anwendbar");
        for (BezugsbasisVergleichDto.Monat m : v.monate()) {
            if (m.bereinigt() != null && m.bereinigt().grund() != null) {
                ObjectNode g = gruende.addObject();
                g.put("periode", m.periode());
                g.put("grund", m.bereinigt().grund());
            }
        }

        // ---------------------------------------------------------------- Statische Faktoren (Kopie)
        ArrayNode fs = abzug.putArray("statische_faktoren");
        for (Faktor x : faktoren) {
            ObjectNode n = fs.addObject();
            n.put("position", x.position());
            n.put("art", x.art());
            n.put("kennzeichen", x.kennzeichen());
            n.put("wortlaut", x.wortlaut());
            n.put("wert", text(x.wert()));
            n.put("einheit", x.einheit());
            n.put("wert_gueltig_ab", x.wertGueltigAb() == null ? null : x.wertGueltigAb().toString());
            n.put("kopie_am", x.kopieAm() == null ? null : x.kopieAm().toString());
        }

        // ---------------------------------------------------------------- Quellen (S2)
        UUID kz = v.kennzahl().id();
        for (BezugsbasisVergleichDto.Monat m : v.monate()) {
            YearMonth ym = YearMonth.parse(m.periode());
            BezugsbasisVergleichDto.Gemessen g = m.bereinigt() == null ? null : m.bereinigt().gemessen();
            if (g != null && g.version() != null) {
                quellen.add(new BerichtAbzugBildung.Quelle(KENNZAHL, v.kennzahl().kennzeichen(), kz,
                        BerichtRegeln.UNMITTELBAR, ym.atDay(1), ym.atEndOfMonth(), g.version(), null,
                        v.kennzahl().name()));
            }
        }
        for (Eingang e : eingaenge) {
            String bezug = MESSSTELLE.equals(e.art()) || KENNZAHL.equals(e.art()) ? BerichtRegeln.MITTELBAR
                    : BerichtRegeln.UNMITTELBAR;
            quellen.add(new BerichtAbzugBildung.Quelle(e.art(), e.kennzeichen(), e.objekt(), bezug, e.ersterTag(),
                    e.letzterTag(), e.version(), e.fassung(), e.name() == null ? e.kennzeichen() : e.name()));
        }
        // Die Einflussgrößen der Bedingung, jede mit ihrer wirksamen Fassung (sofern nicht schon als Eingang zitiert).
        Set<String> schon = new LinkedHashSet<>();
        quellen.forEach(q -> schon.add(q.art() + "|" + q.kennzeichen() + "|" + q.ersterTag()));
        for (BezugsbasisVergleichDto.Monat m : v.monate()) {
            if (m.bereinigt() == null) {
                continue;
            }
            YearMonth ym = YearMonth.parse(m.periode());
            for (BezugsbasisVergleichDto.Bedingung b : m.bereinigt().bedingung()) {
                if (!BEZUGSGROESSE.equals(b.quelle()) || b.wert() == null) {
                    continue;
                }
                UUID objekt = bezugsgroessen.get(b.kennzeichen());
                if (objekt == null || !schon.add(BEZUGSGROESSE + "|" + b.kennzeichen() + "|" + ym.atDay(1))) {
                    continue;
                }
                quellen.add(new BerichtAbzugBildung.Quelle(BEZUGSGROESSE, b.kennzeichen(), objekt,
                        BerichtRegeln.UNMITTELBAR, ym.atDay(1), ym.atEndOfMonth(), null, b.fassung(),
                        b.name() == null ? b.kennzeichen() : b.name()));
            }
        }
        quellen.add(new BerichtAbzugBildung.Quelle(BEZUGSBASIS, f.basis(), f.basisId(), BerichtRegeln.VERGLEICH,
                z.ersterTag(), z.letzterTag(), null, f.fassung(), "Bezugsbasis " + f.basis()));

        // Der Kopf nennt die Kennzeichen (wie jede Vorlage); der Abschnitt `quellenverzeichnis` jede Quelle mit Bezug,
        // Version bzw. Fassung und Tagen — gleiche Zeilen über aufeinanderfolgende Monate zusammengefasst.
        ArrayNode kennzeichen = kopf.putArray("quellenverzeichnis");
        quellen.stream().map(BerichtAbzugBildung.Quelle::kennzeichen).distinct().sorted().forEach(kennzeichen::add);
        ArrayNode verzeichnis = abzug.putArray("quellenverzeichnis");
        Map<String, ObjectNode> gruppen = new LinkedHashMap<>();
        for (BerichtAbzugBildung.Quelle q : quellen) {
            String schluessel = q.art() + "|" + q.kennzeichen() + "|" + q.bezug() + "|" + q.version() + "|" + q.fassung();
            ObjectNode n = gruppen.get(schluessel);
            if (n == null) {
                n = verzeichnis.addObject();
                n.put("art", q.art());
                n.put("kennzeichen", q.kennzeichen());
                n.put("name_zum_datenstand", q.name());
                n.put("bezug", q.bezug());
                n.put("version", q.version());
                n.put("fassung", q.fassung());
                n.put("erster_tag", q.ersterTag().toString());
                gruppen.put(schluessel, n);
            }
            n.put("letzter_tag", q.letzterTag().toString());
        }
        return new Ergebnis(abzug, quellen, List.of());
    }

    /** Die Kennzeichen des Vergleichs in der Folge ihres ersten Auftretens (Monate, dann Zeitraum; G5). */
    static List<String> kennzeichenDes(BezugsbasisVergleichDto.Vergleich v) {
        Set<String> aus = new LinkedHashSet<>();
        for (BezugsbasisVergleichDto.Monat m : v.monate()) {
            if (m.bereinigt() != null && m.bereinigt().kennzeichen() != null) {
                aus.addAll(m.bereinigt().kennzeichen());
            }
        }
        if (v.zeitraum() != null && v.zeitraum().kennzeichen() != null) {
            aus.addAll(v.zeitraum().kennzeichen());
        }
        return List.copyOf(aus);
    }

    /** S3/F2 — die Werte, deren Endgültigkeit die Freigabe prüft: gemessen und jede Bedingung je Periode. */
    static List<BerichtRegeln.FreigabeWert> freigabeWerte(JsonNode abzug) {
        List<BerichtRegeln.FreigabeWert> raus = new ArrayList<>();
        String kz = abzug.path("kennzahl").path("kennzeichen").asText(null);
        String name = abzug.path("kennzahl").path("name_zum_datenstand").asText(null);
        abzug.path("vergleich_je_periode").forEach(m -> {
            JsonNode b = m.path("bereinigt");
            String zustand = b.path("gemessen").path("zustand").asText(null);
            if (zustand != null) {
                raus.add(new BerichtRegeln.FreigabeWert(kz, name, zustand(zustand), null));
            }
            b.path("bedingung").forEach(x -> {
                String z = x.path("zustand").asText(null);
                if (z != null) {
                    raus.add(new BerichtRegeln.FreigabeWert(x.path("kennzeichen").asText(kz),
                            x.path("name").asText(null), zustand(z), null));
                }
            });
        });
        return raus;
    }

    /** Kennzeichen → Bezugsgröße des Kundenbereichs (die Bedingung nennt ihre Variablen mit Kennzeichen). */
    static Map<String, UUID> bezugsgroessen(JdbcTemplate j, UUID tenant) {
        Map<String, UUID> aus = new LinkedHashMap<>();
        j.query("SELECT id, kennzeichen FROM bezugsgroesse WHERE tenant_id = ?",
                rs -> {
                    aus.put(rs.getString("kennzeichen"), rs.getObject("id", UUID.class));
                }, tenant);
        return aus;
    }

    /** Der Zustand eines Werts in der Sprache der Freigabe (F2): nur „vorläufig“ hält sie auf. */
    private static String zustand(String zustand) {
        return "vorlaeufig".equals(zustand) ? KennzahlRegeln.VORLAEUFIG : zustand;
    }

    private static String referenzBezeichnung(String referenzperiode, ZoneId zone) {
        try {
            return BerichtRegeln.zeitraum(BerichtRegeln.DATENGRUNDLAGE, referenzperiode, zone).bezeichnung();
        } catch (RuntimeException e) {
            return referenzperiode;
        }
    }

    private static JsonNode koeffizienten(ObjectMapper json, String text) {
        if (text == null) {
            return json.nullNode();
        }
        try {
            return json.readTree(text);
        } catch (java.io.IOException e) {
            throw new IllegalStateException("Koeffizienten der Fassung sind kein JSON", e);
        }
    }

    private static String text(BigDecimal d) {
        return d == null ? null : d.stripTrailingZeros().toPlainString();
    }
}
