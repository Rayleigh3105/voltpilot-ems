package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.KennzahlEingangLeser.Gelesen;
import com.voltpilot.api.uems.KennzahlRepository.EingangZeile;
import com.voltpilot.api.uems.KennzahlService.Aufgeloest;
import com.voltpilot.api.web.dto.BezugsbasisVergleichDto;
import com.voltpilot.api.web.dto.KennzahlDto;
import java.math.BigDecimal;
import java.sql.Date;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Der Vergleich einer Kennzahl mit ihrer Bezugsbasis (UEMS AP-17 IP-19, U1–U6, E7 = A: ein Leser, ein Vertrag). Je Monat
 * gemessen (der gespeicherte Zähler der Kennzahl mit Version), die Bedingung (jede Variable mit Wert und Fassung) und das
 * Ergebnis der Operation {@code vergleich} gegen die Fassung, die am LETZTEN Tag des Monats gilt (P4); der Zeitraum über
 * die Operation {@code zeitraum} (Σ ÷ Σ, U5). Die rohe Veränderung zum Vormonat steht getrennt und trägt nie ein Urteil
 * (U1, VG3).
 *
 * <p><b>Gerechnet wird hier nichts:</b> erwartet, Δ, Band, Urteil, Spannweite und Kennzeichen-Liste kommen aus
 * {@link BezugsbasisRegeln} (die Zwillinge von IP-2), aus der eingefrorenen Fassung (M4). Gelesen werden nur freigegebene
 * Fassungen; ein Entwurf vergleicht nie.
 *
 * <p><b>Sichtbarkeit:</b> über die Kennzahl ({@link KennzahlService#fuerBezugsbasis}) — außerhalb der Sicht oder in einem
 * fremden Kundenbereich 404; eine Bezugsbasis einer anderen Kennzahl ist 404.
 */
@Service
public class BezugsbasisVergleich {

    static final Set<String> PARAMETER = Set.of("basis", "von", "bis");
    static final int HOECHSTENS_MONATE = 120;
    private static final Pattern MONAT = Pattern.compile("\\d{4}-(0[1-9]|1[0-2])");
    private static final Pattern BASIS = Pattern.compile("BB-\\d{4,}");
    private static final String OHNE = "ohne_urteil";
    /** Variable 1 ohne Bezugsgröße (Zusammenfassung: Σ der Nenner ihrer Paare). */
    static final String NENNER = "Summe der Nenner";

    private final KennzahlService kennzahlen;
    private final KennzahlWerteService werte;
    private final KennzahlRepository repo;
    private final BezugsgroesseRepository bezugsgroessen;
    private final KennzahlEingangLeser leser;
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public BezugsbasisVergleich(KennzahlService kennzahlen, KennzahlWerteService werte, KennzahlRepository repo,
            BezugsgroesseRepository bezugsgroessen, KennzahlEingangLeser leser, JdbcTemplate jdbc, ObjectMapper json) {
        this.kennzahlen = kennzahlen;
        this.werte = werte;
        this.repo = repo;
        this.bezugsgroessen = bezugsgroessen;
        this.leser = leser;
        this.jdbc = jdbc;
        this.json = json;
    }

    /** Die Einheit des Zählers und des Nenners, der Name einer Variable 1 ohne Bezugsgröße. */
    private record Einheiten(String zaehler, String nenner, String nennerName) {}

    private record Basis(UUID id, String kennzeichen, LocalDate beendetZum, String beendetGrund) {}

    /** Eine Variable der Fassung: Position, Bezugsgröße, Spannweite min–max der Referenzperiode. */
    private record VariableZeile(int position, UUID bezugsgroesse, String von, String bis) {}

    /** Eine freigegebene Fassung, wie gespeichert, und ihre Form für die Regeln. */
    private record FassungZeile(int fassung, String methode, String referenzperiode, String datenlage, LocalDate giltAb,
            LocalDate giltBis, List<VariableZeile> variablen, BezugsbasisRegeln.Fassung regel) {

        boolean giltAm(LocalDate tag) {
            return !giltAb.isAfter(tag) && (giltBis == null || !giltBis.isBefore(tag));
        }
    }

    /** Die Monatswerte einer Variablen der Bedingung; {@code bezugsgroesse} leer für den gespeicherten Nenner. */
    private record Variablenwert(BezugsbasisRegeln.Wert wert, BezugsbasisVergleichDto.Bedingung bedingung,
            UUID bezugsgroesse) {}

    public BezugsbasisVergleichDto.Vergleich vergleich(UUID id, Collection<String> parameter, String basisText,
            String vonText, String bisText) {
        parameter.stream().filter(p -> !PARAMETER.contains(p)).findFirst().ifPresent(p -> {
            throw BezugsbasisAbgelehnt.anfrage(p);
        });
        KennzahlService.BasisKennzahl k = kennzahlen.fuerBezugsbasis(id, null, null, null);
        LocalDate heute = LocalDate.ofInstant(k.jetzt(), k.zone());
        YearMonth[] spanne = spanne(vonText, bisText, YearMonth.from(heute));
        return lesen(id, k, basisText, spanne[0], spanne[1]).vergleich();
    }

    /**
     * Ein Monat für den Ziel-Stand (AP-18 IP-6, Z3): die Vergleichszeile des Lesers, der Eingang der Operation
     * {@code vergleich} gegen die Fassung am letzten Tag des Monats (P4) samt deren Referenzperiode und ob der
     * gespeicherte Monatswert zum Abruf endgültig ist ({@code endgueltig_ab} erreicht); für die Wirkung (IP-11) dazu
     * der rohe Kennzahl-Wert des Monats ohne Wort ({@code null} = keiner) und die Variable, die der Monatssatz nennt.
     */
    public record ZielMonat(BezugsbasisVergleichDto.Monat zeile, VerbesserungRegeln.MonatEingang eingang,
            boolean endgueltig, String kennzahl, BezugsbasisVergleichSatz.Variable variable) {}

    /** Der Vergleich über die Zielperiode und je Monat der Eingang für {@link VerbesserungRegeln#zielstand}. */
    public record ZielVergleich(BezugsbasisVergleichDto.Vergleich vergleich, List<ZielMonat> monate, LocalDate heute) {}

    /**
     * AP-18 IP-6 (Z3): der Vergleich der Kennzahl gegen die zitierte Bezugsbasis {@code basisText} über die Monate
     * {@code von}–{@code bis} — derselbe Leser, gerechnet wird hier nichts. Sichtbarkeit wie {@link #vergleich} (404).
     */
    public ZielVergleich fuerZiel(UUID id, String basisText, YearMonth von, YearMonth bis) {
        KennzahlService.BasisKennzahl k = kennzahlen.fuerBezugsbasis(id, null, null, null);
        return lesen(id, k, basisText, von, bis);
    }

    private ZielVergleich lesen(UUID id, KennzahlService.BasisKennzahl k, String basisText, YearMonth von,
            YearMonth bis) {
        LocalDate heute = LocalDate.ofInstant(k.jetzt(), k.zone());
        KennzahlDto.Werte gelesen = werte.werte(id, Set.of("periode", "von", "bis"), "monat",
                von.minusMonths(1).atDay(1).toString(), bis.atEndOfMonth().toString(), null);
        Map<String, KennzahlDto.Wert> jeMonat = new HashMap<>();
        gelesen.werte().forEach(w -> jeMonat.put(w.schluessel(), w));
        Einheiten einheiten = einheiten(k, gelesen.kennzahl().einheit());

        Basis basis = basis(id, basisText);
        List<FassungZeile> fassungen = basis == null ? List.of() : fassungen(basis, einheiten);
        Map<UUID, Map<String, Gelesen>> variablen = new HashMap<>();
        for (FassungZeile f : fassungen) {
            for (VariableZeile v : f.variablen()) {
                variablen.computeIfAbsent(v.bezugsgroesse(), b -> lies(b, von, bis));
            }
        }

        List<BezugsbasisVergleichDto.Monat> monate = new ArrayList<>();
        List<ZielMonat> ziel = new ArrayList<>();
        for (YearMonth m = von; !m.isAfter(bis); m = m.plusMonths(1)) {
            ZielMonat z = monat(m, heute, jeMonat, einheiten, basis, fassungen, variablen, k.jetzt());
            monate.add(z.zeile());
            ziel.add(z);
        }

        BezugsbasisVergleichDto.Zeitraum zeitraum = zeitraum(von, bis, heute, jeMonat, einheiten, basis, fassungen,
                variablen, gelesen);
        BezugsbasisVergleichDto.Basis kopfBasis = basis == null ? null
                : new BezugsbasisVergleichDto.Basis(basis.id(), basis.kennzeichen(), basis.beendetZum(),
                        basis.beendetGrund());
        List<BezugsbasisVergleichDto.Stand> staende = basis == null ? List.of() : staende(basis.id(), k.zone());
        return new ZielVergleich(new BezugsbasisVergleichDto.Vergleich(gelesen.kennzahl(), kopfBasis, von.toString(),
                bis.toString(), gelesen.zeitzone(), List.copyOf(monate), zeitraum, staende,
                BezugsbasisVergleichSatz.stand(staende), basis == null ? BezugsbasisVergleichSatz.LEER : null),
                List.copyOf(ziel), heute);
    }

    /**
     * S5 (AP-17 IP-21b): die freigegebenen Leistungsvergleichs-Stände, die diese Bezugsbasis zitieren (Quellenart
     * {@code bezugsbasis}, auch ein ersetzter) — der jüngste vorn, der Tag der Freigabe in der Zone der Kennzahl.
     */
    private List<BezugsbasisVergleichDto.Stand> staende(UUID basis, java.time.ZoneId zone) {
        return jdbc.query("""
                SELECT DISTINCT s.nr, s.freigegeben_am FROM bericht_stand s
                  JOIN bericht_quelle q ON q.tenant_id = s.tenant_id AND q.bericht_id = s.bericht_id AND q.stand_nr = s.nr
                 WHERE q.art = 'bezugsbasis' AND q.objekt_id = ?
                 ORDER BY s.freigegeben_am DESC, s.nr DESC
                """, (rs, i) -> new BezugsbasisVergleichDto.Stand(rs.getInt("nr"),
                        LocalDate.ofInstant(rs.getTimestamp("freigegeben_am").toInstant(), zone)), basis);
    }

    // ================================================================================ je Monat

    private ZielMonat monat(YearMonth m, LocalDate heute, Map<String, KennzahlDto.Wert> jeMonat,
            Einheiten einheiten, Basis basis, List<FassungZeile> fassungen, Map<UUID, Map<String, Gelesen>> variablen,
            java.time.Instant jetzt) {
        KennzahlDto.Wert w = jeMonat.get(m.toString());
        KennzahlDto.Wert vorher = jeMonat.get(m.minusMonths(1).toString());
        String beschriftung = w != null ? w.beschriftung() : KennzahlRegeln.periodeText("monat", m.toString());

        Map<String, Object> r = BezugsbasisRegeln.roh(zaehler(w), zaehler(vorher));
        Object variableDelta = BezugsbasisRegeln.roh(nenner(w), nenner(vorher)).get("delta_prozent");
        BezugsbasisVergleichDto.Roh roh = new BezugsbasisVergleichDto.Roh(zaehler(w), zaehler(vorher),
                (String) r.get("delta_prozent"), (String) r.get("richtung"), (String) variableDelta, OHNE);

        LocalDate letzter = m.atEndOfMonth();
        FassungZeile f = fassungAm(fassungen, letzter);
        boolean beendet = f == null && beendet(basis, fassungen, letzter);
        List<Variablenwert> bedingung = f == null ? List.of() : bedingung(f, m, w, einheiten, variablen);
        BezugsbasisRegeln.VergleichEingang eingang = new BezugsbasisRegeln.VergleichEingang(
                f == null ? null : f.regel(), beendet, letzter.isBefore(heute), gemessen(w),
                bedingung.stream().map(Variablenwert::wert).toList());
        Map<String, Object> e = BezugsbasisRegeln.vergleich(eingang);

        BezugsbasisVergleichDto.Bereinigt bereinigt = new BezugsbasisVergleichDto.Bereinigt(fassungDto(f),
                new BezugsbasisVergleichDto.Gemessen(zaehler(w), einheiten.zaehler(), w == null ? null : w.version(),
                        w == null ? null : w.zustand()),
                bedingung.stream().map(Variablenwert::bedingung).toList(), (String) e.get("erwartet"),
                (String) e.get("delta_prozent"), (String) e.get("band_prozent"), (String) e.get("richtung"),
                (String) e.get("urteil"), (String) e.get("grund"), kennzeichen(e));

        FassungZeile folge = beendet ? fassungen.stream().filter(x -> x.giltAb().isAfter(letzter)).findFirst()
                .orElse(null) : null;
        int i = satzIndex(f, bedingung, (String) e.get("grund"));
        BezugsbasisVergleichSatz.Variable v = bedingung.isEmpty() ? null : satzVariable(f, bedingung.get(i), i);
        String hinweis = "variable_fehlt".equals(e.get("grund")) ? koordinatenFehlen(bedingung.get(i)) : null;
        String satz = BezugsbasisVergleichSatz.monat(e, new BezugsbasisVergleichSatz.Monat(beschriftung, einheiten.zaehler(),
                v, basis == null ? null : basis.kennzeichen(), beendetZum(basis, fassungen, letzter),
                basis == null ? null : basis.beendetGrund(), folge == null ? null : folge.fassung(),
                folge == null ? null : folge.giltAb(), hinweis));
        boolean endgueltig = w != null && w.endgueltigAb() != null
                && !java.time.OffsetDateTime.parse(w.endgueltigAb()).toInstant().isAfter(jetzt);
        return new ZielMonat(new BezugsbasisVergleichDto.Monat(m.toString(), beschriftung, roh, bereinigt, satz),
                new VerbesserungRegeln.MonatEingang(m.toString(), f == null ? null : f.referenzperiode(), eingang),
                endgueltig, w == null ? null : w.wert(), v);
    }

    /**
     * U5 mit P4: der Zeitraum ist eine Periode — er liest die Fassung am letzten Tag von {@code bis} und vergleicht jeden
     * Monat gegen sie (Operation {@code zeitraum}).
     */
    private BezugsbasisVergleichDto.Zeitraum zeitraum(YearMonth von, YearMonth bis, LocalDate heute,
            Map<String, KennzahlDto.Wert> jeMonat, Einheiten einheiten, Basis basis, List<FassungZeile> fassungen,
            Map<UUID, Map<String, Gelesen>> variablen, KennzahlDto.Werte gelesen) {
        LocalDate letzter = bis.atEndOfMonth();
        FassungZeile f = fassungAm(fassungen, letzter);
        List<BezugsbasisRegeln.Monat> monate = new ArrayList<>();
        int soll = 0;
        for (YearMonth m = von; !m.isAfter(bis); m = m.plusMonths(1)) {
            soll++;
            KennzahlDto.Wert w = jeMonat.get(m.toString());
            List<BezugsbasisRegeln.Wert> b = f == null ? List.of()
                    : bedingung(f, m, w, einheiten, variablen).stream().map(Variablenwert::wert).toList();
            monate.add(new BezugsbasisRegeln.Monat(m.atEndOfMonth().isBefore(heute), gemessen(w), b));
        }
        Map<String, Object> e = BezugsbasisRegeln.zeitraum(new BezugsbasisRegeln.ZeitraumEingang(
                f == null ? null : f.regel(), f == null && beendet(basis, fassungen, letzter), soll, monate));
        String vonText = KennzahlRegeln.periodeText("monat", von.toString());
        String bisText = KennzahlRegeln.periodeText("monat", bis.toString());
        return new BezugsbasisVergleichDto.Zeitraum(f == null ? null : f.fassung(), (String) e.get("gemessen"),
                (String) e.get("erwartet"), (String) e.get("delta_prozent"), (String) e.get("band_prozent"),
                (String) e.get("richtung"), (String) e.get("urteil"), (String) e.get("grund"), (String) e.get("monate"),
                kennzeichen(e), BezugsbasisVergleichSatz.zeitraum(e, vonText, bisText, einheiten.zaehler(), soll));
    }

    /**
     * U4: je Variable der Fassung ihr Monatswert. Eine Bezugsgröße liest der Kennzahl-Eingangsleser (wirksame Fassung,
     * nie verteilt); ohne Bezugsgröße an Position 1 — Stammdatum-Nenner (V3) oder Zusammenfassung (Σ ÷ Σ der Paare, B2) —
     * ist Variable 1 der gespeicherte Nenner der Kennzahl mit ihrer Version.
     */
    private List<Variablenwert> bedingung(FassungZeile f, YearMonth m, KennzahlDto.Wert w, Einheiten einheiten,
            Map<UUID, Map<String, Gelesen>> variablen) {
        List<Variablenwert> aus = new ArrayList<>();
        if (f.variablen().isEmpty() || f.variablen().get(0).position() != 1) {
            BezugsbasisRegeln.Variable v = f.regel().variablen().get(0);
            aus.add(new Variablenwert(new BezugsbasisRegeln.Wert(nenner(w), zustand(w == null ? null : w.zustand()),
                    List.of()), new BezugsbasisVergleichDto.Bedingung(1, KennzahlRegeln.KENNZAHL, null, v.name(),
                            nenner(w), v.einheit(), null, w == null ? null : w.version(),
                            w == null ? null : w.zustand()), null));
        }
        for (VariableZeile vz : f.variablen()) {
            BezugsgroesseRepository.Zeile b = bezugsgroessen.finde(vz.bezugsgroesse()).orElseThrow();
            Gelesen g = variablen.get(vz.bezugsgroesse()).get(m.toString());
            String wert = g == null || g.eingang().wert() == null ? null : text(g.eingang().wert());
            String zustand = g == null ? null : g.eingang().zustand();
            List<String> kz = new ArrayList<>();
            if (g != null) {
                g.herkunft().forEach(x -> {
                    if (!kz.contains(x)) kz.add(x);
                });
                if (g.eingang().kennzeichen() != null) {
                    g.eingang().kennzeichen().forEach(x -> {
                        if (!kz.contains(x)) kz.add(x);
                    });
                }
            }
            aus.add(new Variablenwert(new BezugsbasisRegeln.Wert(wert, zustand(zustand), kz),
                    new BezugsbasisVergleichDto.Bedingung(vz.position(), KennzahlRegeln.BEZUGSGROESSE, b.kennzeichen(),
                            b.name(), wert, b.einheit(), g == null ? null : g.fassung(), null, zustand),
                    vz.bezugsgroesse()));
        }
        return aus;
    }

    private Map<String, Gelesen> lies(UUID bezugsgroesse, YearMonth von, YearMonth bis) {
        KennzahlRepository.BezugsgroesseZeile b = repo.bezugsgroesse(bezugsgroesse).orElseThrow();
        Aufgeloest x = new Aufgeloest("nenner", KennzahlRegeln.BEZUGSGROESSE, b.id(), b.kennzeichen(), b.name(),
                b.einheit(), null, b.wertart(), b.periodeArt(), null, b, null);
        return leser.lies(x, "monat", von.atDay(1), bis.atEndOfMonth());
    }

    // ================================================================================ Bezugsbasis und Fassungen

    /** Mit {@code basis} genau diese (an dieser Kennzahl, sonst 404); ohne die laufende, sonst die zuletzt beendete. */
    private Basis basis(UUID kennzahl, String kennzeichen) {
        String spalten = "SELECT id, kennzeichen, beendet_zum, beendet_grund FROM bezugsbasis WHERE kennzahl_id = ? ";
        if (kennzeichen != null) {
            if (!BASIS.matcher(kennzeichen).matches()) {
                throw BezugsbasisAbgelehnt.anfrage("basis");
            }
            return jdbc.query(spalten + "AND kennzeichen = ?", (rs, i) -> basisZeile(rs), kennzahl, kennzeichen).stream()
                    .findFirst().orElseThrow(BezugsbasisAbgelehnt::nichtGefunden);
        }
        return jdbc.query(spalten + "ORDER BY (beendet_am IS NULL) DESC, beendet_zum DESC NULLS LAST, created_at DESC "
                + "LIMIT 1", (rs, i) -> basisZeile(rs), kennzahl).stream().findFirst().orElse(null);
    }

    private static Basis basisZeile(java.sql.ResultSet rs) throws java.sql.SQLException {
        Date zum = rs.getDate("beendet_zum");
        return new Basis(rs.getObject("id", UUID.class), rs.getString("kennzeichen"),
                zum == null ? null : zum.toLocalDate(), rs.getString("beendet_grund"));
    }

    /** Nur freigegebene Fassungen; Basiswert, Koeffizienten, Streuung und Spannweite als eingefrorene Kopie (M4). */
    private List<FassungZeile> fassungen(Basis basis, Einheiten einheiten) {
        return jdbc.query("SELECT f.id, f.fassung, f.methode, f.referenzperiode, f.datenlage, f.gilt_ab, f.gilt_bis, "
                + "f.basiswert, f.koeffizienten::text AS koeffizienten, f.streuung_prozent, f.toleranz_prozent, "
                + "f.grundlage FROM bezugsbasis_fassung f WHERE f.bezugsbasis_id = ? AND f.freigabe_status = 'freigegeben' "
                + "ORDER BY f.fassung", (rs, i) -> {
                    UUID fid = rs.getObject("id", UUID.class);
                    Date bis = rs.getDate("gilt_bis");
                    return new Object[] {fid, rs.getInt("fassung"), rs.getString("methode"),
                        rs.getString("referenzperiode"), rs.getString("datenlage"), rs.getDate("gilt_ab").toLocalDate(),
                        bis == null ? null : bis.toLocalDate(), rs.getBigDecimal("basiswert"),
                        rs.getString("koeffizienten"), rs.getBigDecimal("streuung_prozent"),
                        rs.getBigDecimal("toleranz_prozent"), rs.getString("grundlage")};
                }, basis.id()).stream().map(o -> fassung(basis, einheiten, o)).toList();
    }

    private FassungZeile fassung(Basis basis, Einheiten einheiten, Object[] o) {
        UUID fid = (UUID) o[0];
        int nummer = (Integer) o[1];
        String methode = (String) o[2], referenzperiode = (String) o[3];
        List<VariableZeile> variablen = jdbc.query("SELECT position, bezugsgroesse_id, spannweite_von, spannweite_bis "
                + "FROM bezugsbasis_variable WHERE fassung_id = ? AND aufgehoben_am IS NULL ORDER BY position",
                (rs, i) -> new VariableZeile(rs.getInt("position"), rs.getObject("bezugsgroesse_id", UUID.class),
                        text(rs.getBigDecimal("spannweite_von")), text(rs.getBigDecimal("spannweite_bis"))), fid);
        List<BezugsbasisRegeln.Variable> regelVariablen = new ArrayList<>();
        List<BezugsbasisRegeln.Spannweite> spannweite = new ArrayList<>();
        if (variablen.isEmpty() || variablen.get(0).position() != 1) {
            regelVariablen.add(new BezugsbasisRegeln.Variable(einheiten.nennerName(), einheiten.nenner(), ""));
        }
        for (VariableZeile v : variablen) {
            BezugsgroesseRepository.Zeile b = bezugsgroessen.finde(v.bezugsgroesse()).orElseThrow();
            regelVariablen.add(new BezugsbasisRegeln.Variable(b.name(), b.einheit(), b.art() == null ? "" : b.art()));
            if (v.von() != null) {
                // G3 (Startwert ± 10 %) wie BezugsbasisRegeln.spannweite: [min × 0,9, max × 1,1], exakt.
                BigDecimal p = new BigDecimal(BezugsbasisRegeln.STARTWERTE.spannweite_prozent()).movePointLeft(2);
                spannweite.add(new BezugsbasisRegeln.Spannweite(v.von(), v.bis(),
                        text(new BigDecimal(v.von()).multiply(BigDecimal.ONE.subtract(p))),
                        text(new BigDecimal(v.bis()).multiply(BigDecimal.ONE.add(p)))));
            }
        }
        JsonNode ko = lies((String) o[8]);
        BezugsbasisRegeln.Koeffizienten koeffizienten = ko.isObject() ? new BezugsbasisRegeln.Koeffizienten(
                feld(ko, "a"), feld(ko, "b"), feld(ko, "c")) : null;
        JsonNode grundlage = lies((String) o[11]);
        int monate = grundlage.path("monate").isInt() ? grundlage.path("monate").asInt() : monateIn(referenzperiode);
        BezugsbasisRegeln.Fassung regel = new BezugsbasisRegeln.Fassung(basis.kennzeichen(), nummer, methode, monate,
                text((BigDecimal) o[7]), koeffizienten, text((BigDecimal) o[9]), text((BigDecimal) o[10]),
                spannweite.size() == regelVariablen.size() ? spannweite : null, regelVariablen);
        return new FassungZeile(nummer, methode, referenzperiode, (String) o[4], (LocalDate) o[5], (LocalDate) o[6],
                variablen, regel);
    }

    /** P4: die Fassung, die am Tag gilt. */
    private static FassungZeile fassungAm(List<FassungZeile> fassungen, LocalDate tag) {
        return fassungen.stream().filter(f -> f.giltAm(tag)).reduce((a, b) -> b).orElse(null);
    }

    /** G2: ohne gültige Fassung „beendet“, wenn die Basis oder eine Fassung vor dem Tag endete — sonst „fehlt“. */
    private static boolean beendet(Basis basis, List<FassungZeile> fassungen, LocalDate tag) {
        return beendetZum(basis, fassungen, tag) != null;
    }

    private static LocalDate beendetZum(Basis basis, List<FassungZeile> fassungen, LocalDate tag) {
        if (basis == null || fassungAm(fassungen, tag) != null) {
            return null;
        }
        if (basis.beendetZum() != null && basis.beendetZum().isBefore(tag)) {
            return basis.beendetZum();
        }
        return fassungen.stream().map(FassungZeile::giltBis).filter(b -> b != null && b.isBefore(tag))
                .max(LocalDate::compareTo).orElse(null);
    }

    // ================================================================================ Hilfen

    /**
     * Die Einheit des Zählers (die Energie) und des Nenners: aus der Messstelle bzw. Bezugsgröße der heute geltenden
     * Fassung, sonst aus der Kennzahl-Einheit „Zähler/Nenner“. Setzt Name und Einheit einer Variable 1 ohne Bezugsgröße.
     */
    private Einheiten einheiten(KennzahlService.BasisKennzahl k, String einheit) {
        String[] teile = einheit == null ? new String[0] : einheit.split("/", 2);
        String zaehler = teile.length > 0 ? teile[0].trim() : "";
        String nenner = teile.length > 1 ? teile[1].trim() : "";
        String nennerName = NENNER;
        for (EingangZeile e : k.eingaenge()) {
            if ("zaehler".equals(e.rolle()) && KennzahlRegeln.MESSSTELLE.equals(e.art())) {
                zaehler = repo.messstelle(e.objektId()).map(KennzahlRepository.MessstelleZeile::einheit).orElse(zaehler);
            }
            if ("nenner".equals(e.rolle()) && KennzahlRegeln.BEZUGSGROESSE.equals(e.art())) {
                var b = repo.bezugsgroesse(e.objektId());
                if (b.isPresent()) {
                    nenner = b.get().einheit();
                    nennerName = b.get().name();
                }
            }
        }
        return new Einheiten(zaehler, nenner, nennerName);
    }

    private static BezugsbasisVergleichDto.Fassung fassungDto(FassungZeile f) {
        return f == null ? null : new BezugsbasisVergleichDto.Fassung(f.fassung(), f.methode(), f.referenzperiode(),
                f.datenlage(), f.giltAb(), f.giltBis());
    }

    /**
     * G2/G3 (IP-13): welche Variable der Satz nennt — bei {@code variable_fehlt} die erste ohne Wert, bei
     * {@code variable_ausserhalb} die erste außerhalb ihrer tolerierten Spannweite, sonst Variable 1. Nur die Wahl des
     * Namens; ob die Periode einen Grund trägt, entscheidet allein die Operation {@code vergleich}.
     */
    private static int satzIndex(FassungZeile f, List<Variablenwert> bedingung, String grund) {
        List<BezugsbasisRegeln.Spannweite> sw = f == null ? null : f.regel().spannweite();
        for (int i = 0; i < bedingung.size(); i++) {
            String wert = bedingung.get(i).wert().wert();
            if ("variable_fehlt".equals(grund) && wert == null) {
                return i;
            }
            if ("variable_ausserhalb".equals(grund) && wert != null && sw != null && i < sw.size()) {
                BigDecimal x = new BigDecimal(wert);
                if (x.compareTo(new BigDecimal(sw.get(i).toleriert_von())) < 0
                        || x.compareTo(new BigDecimal(sw.get(i).toleriert_bis())) > 0) {
                    return i;
                }
            }
        }
        return 0;
    }

    /**
     * G2 (IP-13, §5.8): fehlt einer bezogenen Gradtagzahl der Wert, weil ihr Standort keine Koordinaten hat, sagt der Satz
     * es mit dem Satz des Wetter-Archivs ({@link WetterArchivRegeln#koordinatenFehlen}) — Lindach (RU:201).
     */
    private String koordinatenFehlen(Variablenwert v) {
        if (v.bezugsgroesse() == null || v.wert().wert() != null) {
            return null;
        }
        return jdbc.query("SELECT s.name FROM bezugsgroesse b JOIN bezugsgroesse_wetterbezug w "
                + "ON w.bezugsgroesse_id = b.id AND w.tenant_id = b.tenant_id JOIN standort s ON s.id = b.standort_id "
                + "AND s.tenant_id = b.tenant_id WHERE b.id = ? AND b.art = 'gradtagzahl' "
                + "AND (s.lage_breitengrad IS NULL OR s.lage_laengengrad IS NULL)", (rs, n) -> rs.getString(1),
                v.bezugsgroesse()).stream().findFirst().map(WetterArchivRegeln::koordinatenFehlen).orElse(null);
    }

    private static BezugsbasisVergleichSatz.Variable satzVariable(FassungZeile f, Variablenwert v, int i) {
        BezugsbasisRegeln.Spannweite s = f.regel().spannweite() == null || f.regel().spannweite().size() <= i ? null
                : f.regel().spannweite().get(i);
        return new BezugsbasisVergleichSatz.Variable(v.bedingung().name(), v.bedingung().wert(), v.bedingung().einheit(),
                s == null ? null : s.von(), s == null ? null : s.bis());
    }

    /** Der gemessene Wert: der gespeicherte Zähler mit Zustand und den Kennzeichen des Kennzahl-Werts (G5 Nr. 6). */
    private static BezugsbasisRegeln.Wert gemessen(KennzahlDto.Wert w) {
        return new BezugsbasisRegeln.Wert(zaehler(w), zustand(w == null ? null : w.zustand()),
                w == null || w.kennzeichen() == null ? List.of() : w.kennzeichen());
    }

    /** Der Zustand „unvollständig“ heißt in den Regeln {@code unvollstaendig} (G2). */
    private static String zustand(String zustand) {
        return ErgebnisZustand.UNVOLLSTAENDIG.equals(zustand) ? "unvollstaendig" : zustand;
    }

    private static String zaehler(KennzahlDto.Wert w) {
        return w == null || w.wert() == null ? null : w.zaehler();
    }

    private static String nenner(KennzahlDto.Wert w) {
        return w == null || w.wert() == null ? null : w.nenner();
    }

    @SuppressWarnings("unchecked")
    private static List<String> kennzeichen(Map<String, Object> e) {
        Object k = e.get("kennzeichen");
        return k == null ? List.of() : List.copyOf((List<String>) k);
    }

    private static String text(BigDecimal d) {
        return d == null ? null : d.stripTrailingZeros().toPlainString();
    }

    private static String feld(JsonNode n, String name) {
        JsonNode v = n.get(name);
        return v == null || v.isNull() ? null : v.isNumber() ? text(v.decimalValue()) : v.asText();
    }

    private JsonNode lies(String text) {
        try {
            return text == null ? json.createObjectNode() : json.readTree(text);
        } catch (com.fasterxml.jackson.core.JsonProcessingException x) {
            throw new IllegalStateException(x);
        }
    }

    private static int monateIn(String referenzperiode) {
        YearMonth a = YearMonth.parse(referenzperiode.substring(0, 7));
        YearMonth b = YearMonth.parse(referenzperiode.substring(8));
        return (int) (b.getYear() * 12L + b.getMonthValue() - a.getYear() * 12L - a.getMonthValue()) + 1;
    }

    /** {@code von}/{@code bis} als {@code JJJJ-MM}; ohne beide die zwölf abgeschlossenen Monate vor dem laufenden. */
    static YearMonth[] spanne(String von, String bis, YearMonth laufend) {
        YearMonth b = bis == null ? laufend.minusMonths(1) : monat("bis", bis);
        YearMonth a = von == null ? b.minusMonths(11) : monat("von", von);
        if (b.isBefore(a)) {
            throw BezugsbasisAbgelehnt.anfrage("bis");
        }
        if (a.plusMonths(HOECHSTENS_MONATE).isBefore(b.plusMonths(1))) {
            throw BezugsbasisAbgelehnt.anfrage("von");
        }
        return new YearMonth[] {a, b};
    }

    private static YearMonth monat(String feld, String text) {
        if (!MONAT.matcher(text).matches()) {
            throw BezugsbasisAbgelehnt.anfrage(feld);
        }
        try {
            return YearMonth.parse(text);
        } catch (DateTimeParseException x) {
            throw BezugsbasisAbgelehnt.anfrage(feld);
        }
    }
}
