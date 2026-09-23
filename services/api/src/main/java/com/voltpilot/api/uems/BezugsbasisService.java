package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.KennzahlRepository.EingangZeile;
import com.voltpilot.api.uems.KennzahlRepository.FassungZeile;
import com.voltpilot.api.web.dto.BezugsbasisDto;
import com.voltpilot.api.web.dto.BezugsgroesseDto;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.math.BigDecimal;
import java.sql.Date;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.YearMonth;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Bezugsbasis anlegen und eine Fassung als Entwurf mit Vorschau bilden (UEMS AP-17 IP-7, B1, B2, B4, P1–P4, M1, F1,
 * F3). Die Kennzahl bleibt unverändert; Sichtbarkeit und Recht {@code bezugsbasis.verwalten} hängen an ihrer Geltung
 * ({@link KennzahlService#fuerBezugsbasis}, Standort-Zaun über die Kennzahl).
 *
 * <p>Ein Entwurf ist die Vorschau: die Route schreibt ihn und antwortet mit genau dem, was der Leser der gespeicherten
 * Fassung liefert — Vorschau und Kopie sind dieselben Bytes. Ein zweiter Entwurf derselben Basis bildet den offenen
 * Entwurf neu (gleiche Nummer); freigegeben, beantragt oder abgelehnt wird hier nichts (IP-8).
 *
 * <p>Methoden (E4 = A): Verhältnis (M1) und die Modelle mit einer oder zwei Einflussgrößen und über Gradtage (M2–M4,
 * IP-10). Variable 1 ist der Nenner der Kennzahl (V2); ein Modell mit zwei Einflussgrößen nimmt eine zweite Bezugsgröße
 * mit ihren Monatswerten. Gerechnet wird in {@link BezugsbasisRegeln#modell} — hier nur gelesen, geprüft, eingefroren.
 */
@Service
public class BezugsbasisService {

    static final String VERWALTEN = "bezugsbasis.verwalten";
    static final String VERHAELTNIS = "verhaeltnis";
    static final String GRADTAGE = "gradtage";
    static final String ZWEI_VARIABLEN = "regression_zwei_variablen";
    static final String GRADTAGZAHL = "gradtagzahl";

    private static final String BASIS_SPALTEN = "b.id, b.kennzeichen, b.kennzahl_id, b.zweck, b.verantwortlich_name, "
            + "b.beendet_zum, b.beendet_am, b.beendet_grund, b.created_at";
    private static final String FASSUNG_SPALTEN = "f.id, f.fassung, f.referenzperiode, f.methode, f.datenlage, f.gilt_ab, "
            + "f.gilt_bis, f.toleranz_prozent, f.wiedervorlage_monate, f.grundlage, f.pruefsumme, f.basiswert, "
            + "f.freigabe_status, f.actor_name, f.created_at, f.koeffizienten::text AS koeffizienten, f.r2, "
            + "f.streuung_prozent";

    private final KennzahlService kennzahlen;
    private final JdbcTemplate jdbc;
    private final BezugsbasisGrundlage grundlage;
    private final TransactionTemplate transaktion;
    private final ObjectMapper json;
    private final BezugsgroesseService bezugsgroessen;
    private final RechtPruefung rechte;

    public BezugsbasisService(KennzahlService kennzahlen, JdbcTemplate jdbc, PlatformTransactionManager transactionManager,
            ObjectMapper json, BezugsgroesseService bezugsgroessen, RechtPruefung rechte) {
        this.kennzahlen = kennzahlen;
        this.bezugsgroessen = bezugsgroessen;
        this.rechte = rechte;
        this.jdbc = jdbc;
        this.grundlage = new BezugsbasisGrundlage(jdbc);
        this.transaktion = new TransactionTemplate(transactionManager);
        this.json = json;
    }

    private record Basis(UUID id, String kennzeichen, UUID kennzahlId, String zweck, String verantwortlichName,
            LocalDate beendetZum, OffsetDateTime beendetAm, String beendetGrund, OffsetDateTime angelegtAm) {}

    private record FassungZeileDb(UUID id, int fassung, String referenzperiode, String methode, String datenlage,
            LocalDate giltAb, LocalDate giltBis, BigDecimal toleranz, int wiedervorlage, String grundlage,
            String pruefsumme, BigDecimal basiswert, String freigabeStatus, String actorName, OffsetDateTime angelegtAm,
            String koeffizienten, BigDecimal r2, BigDecimal streuung) {}

    // ================================================================================ anlegen (B1, B2, B4)

    public BezugsbasisDto.Bezugsbasis anlegen(UUID kennzahlId, BezugsbasisDto.Anlegen a, ProtokollAkteur wer) {
        KennzahlService.BasisKennzahl k = kennzahlen.fuerBezugsbasis(kennzahlId, VERWALTEN, wer, null);
        if (k.zeile().archiviertAm() != null) {
            throw new BezugsbasisAbgelehnt(409, "kennzahl_archiviert",
                    "Eine archivierte Kennzahl bekommt keine Bezugsbasis.", Map.of("kennzahl", k.zeile().kennzeichen()));
        }
        traeger(k, null);
        String zweck = a == null || a.zweck() == null || a.zweck().isBlank() ? null : a.zweck().strip();
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        UUID neu = transaktion.execute(s -> {
            laufende(kennzahlId).ifPresent(b -> {
                throw laeuft(b);
            });
            String sub = k.zeile().verantwortlichSub();
            String konto = null;
            if (sub != null) {
                List<String> konten = jdbc.queryForList("SELECT konto FROM benutzer WHERE sub = ?", String.class, sub);
                konto = konten.isEmpty() ? null : konten.get(0);
                sub = konto == null ? null : sub;
            }
            String name = k.zeile().verantwortlichName() != null && !k.zeile().verantwortlichName().isBlank()
                    ? k.zeile().verantwortlichName() : wer.name();
            UUID id;
            try {
                id = jdbc.queryForObject("INSERT INTO bezugsbasis (tenant_id, kennzahl_id, zweck, verantwortlich_sub, "
                        + "verantwortlich_name, verantwortlich_konto, actor_sub, actor_name, actor_rolle, actor_art) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", UUID.class, tenant, kennzahlId, zweck,
                        sub, name, konto, wer.sub(), wer.name(), wer.rolle(), wer.art());
            } catch (DuplicateKeyException x) {
                // B1 als Wettlauf: die zweite laufende Basis scheitert am Unique-Index — dieselbe Antwort ohne Fakten.
                throw new BezugsbasisAbgelehnt(409, "bezugsbasis_laeuft",
                        "Diese Kennzahl hat schon eine laufende Bezugsbasis; bilden Sie dort eine neue Fassung.", null);
            }
            Basis b = basis(kennzahlId, id);
            Map<String, Object> inhalt = new LinkedHashMap<>();
            inhalt.put("kennzeichen", b.kennzeichen());
            inhalt.put("kennzahl", k.zeile().kennzeichen());
            inhalt.put("zweck", zweck);
            inhalt.put("verantwortlich_name", name);
            protokoll(tenant, id, null, "bezugsbasis_angelegt", inhalt, wer);
            return id;
        });
        return eine(kennzahlId, neu);
    }

    // ================================================================================ Entwurf (P1–P4, M1, F1, F3)

    public BezugsbasisDto.Fassung entwerfen(UUID kennzahlId, UUID basisId, BezugsbasisDto.Entwurf e, ProtokollAkteur wer) {
        KennzahlService.BasisKennzahl heute = kennzahlen.fuerBezugsbasis(kennzahlId, VERWALTEN, wer, null);
        Basis basis = basis(kennzahlId, basisId);
        if (basis.beendetAm() != null) {
            throw new BezugsbasisAbgelehnt(409, "bezugsbasis_beendet", "Diese Bezugsbasis ist beendet.",
                    Map.of("bezugsbasis", basis.kennzeichen(), "beendet_zum", basis.beendetZum().toString()));
        }
        if (e == null || e.methode() == null) {
            throw BezugsbasisAbgelehnt.anfrage("methode");
        }
        if (!BezugsbasisRegeln.METHODEN.contains(e.methode())) {
            throw BezugsbasisAbgelehnt.fachlich("methode_unbekannt", "Diese Methode gibt es nicht.",
                    Map.of("methoden", BezugsbasisRegeln.METHODEN));
        }
        String laufend = YearMonth.from(heute.jetzt().atZone(heute.zone())).toString();
        Map<String, Object> periode = BezugsbasisRegeln.referenzperiode(e.referenzperiode(), laufend);
        if (!Boolean.TRUE.equals(periode.get("gueltig"))) {
            String fehler = (String) periode.get("fehler");
            throw BezugsbasisAbgelehnt.fachlich(fehler, switch (fehler) {
                case "periode_nicht_zu_ende" -> "Der laufende Monat ist nie Teil der Referenzperiode.";
                case "referenzperiode_reihenfolge" -> "Das Ende der Referenzperiode liegt vor ihrem Anfang.";
                default -> "Die Referenzperiode ist ganze Monate im Format JJJJ-MM/JJJJ-MM.";
            }, Map.of("referenzperiode", String.valueOf(e.referenzperiode()), "laufender_monat", laufend));
        }
        YearMonth von = YearMonth.parse(e.referenzperiode().substring(0, 7));
        YearMonth bis = YearMonth.parse(e.referenzperiode().substring(8));
        BigDecimal toleranz = toleranz(e.toleranzProzent());
        int wiedervorlage = e.wiedervorlageMonate() == null
                ? BezugsbasisRegeln.STARTWERTE.wiedervorlage_monate() : e.wiedervorlageMonate();
        if (wiedervorlage <= 0) {
            throw BezugsbasisAbgelehnt.fachlich("wiedervorlage_ungueltig",
                    "Die Wiedervorlage ist eine Zahl von Monaten größer als null.", Map.of("wiedervorlage_monate",
                            wiedervorlage));
        }

        // P4: die Fassung der Kennzahl am LETZTEN Tag der Referenzperiode.
        KennzahlService.BasisKennzahl k = kennzahlen.fuerBezugsbasis(kennzahlId, null, wer, bis.atEndOfMonth());
        if (k.fassung() == null) {
            throw keineWerte(e.referenzperiode());
        }
        EingangZeile nenner = traeger(k, e.methode());
        UUID zweiteId = variablen(e.methode(), e.variablen(), nenner);
        String nennerArt = nenner == null ? null : art(nenner.objektId());
        if (GRADTAGE.equals(e.methode()) && !GRADTAGZAHL.equals(nennerArt)) {
            throw BezugsbasisAbgelehnt.fachlich("variable_keine_gradtagzahl", "Die Wetterbereinigung über Gradtage "
                    + "rechnet mit genau einer Größe der Art Gradtagzahl: dem Nenner der Kennzahl.",
                    Map.of("nenner", nenner.kennzeichen(), "art", String.valueOf(nennerArt)));
        }
        BezugsbasisGrundlage.ZweiteVariable zweite = zweiteId == null ? null : zweite(zweiteId, von, bis);
        BezugsbasisGrundlage.Ergebnis g = grundlage.bilden(kennzahlId, k.zeile().kennzeichen(), k.fassung().rechenform(),
                k.fassung().nummer(), e.referenzperiode(), von, bis, e.methode(),
                nenner == null ? null : nenner.objektId(), nenner == null ? null : nenner.kennzeichen(), nennerArt, zweite);
        if (g.basiswert() == null) {
            throw switch (g.grund()) {
                case "zu_wenig_perioden" -> BezugsbasisAbgelehnt.fachlich("zu_wenig_perioden", g.monate()
                        < BezugsbasisRegeln.STARTWERTE.mindest_monate()
                        ? "Modell nicht möglich: " + g.monate() + " von " + BezugsbasisRegeln.STARTWERTE.mindest_monate()
                                + " Monaten in der Referenzperiode. Das Verhältnis ist vorläufig."
                        : "Modell nicht möglich: die Einflussgröße ändert sich in der Referenzperiode nicht.",
                        Map.of("monate", g.monate(), "mindest_monate", BezugsbasisRegeln.STARTWERTE.mindest_monate()));
                case "variable_fehlt" -> BezugsbasisAbgelehnt.fachlich("variable_fehlt",
                        "Modell nicht möglich: " + zweite.kennzeichen() + " hat nicht in jedem Monat einen Wert.",
                        Map.of("variable", zweite.kennzeichen(), "perioden", g.fehlend()));
                default -> keineWerte(e.referenzperiode());
            };
        }
        BezugsbasisGrundlage.Modell modell = g.modell();

        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        LocalDate giltAb = bis.plusMonths(1).atDay(1);
        int nummer = transaktion.execute(s -> {
            jdbc.queryForList("SELECT id FROM bezugsbasis WHERE id = ? FOR UPDATE", UUID.class, basisId);
            List<Map<String, Object>> offen = jdbc.queryForList("SELECT id, fassung, freigabe_status FROM "
                    + "bezugsbasis_fassung WHERE bezugsbasis_id = ? AND freigabe_status IN ('entwurf', 'beantragt')",
                    basisId);
            UUID fassungId;
            int n;
            if (!offen.isEmpty() && "beantragt".equals(offen.get(0).get("freigabe_status"))) {
                throw new BezugsbasisAbgelehnt(409, "fassung_beantragt",
                        "Eine Fassung dieser Bezugsbasis wartet auf die zweite Person.",
                        Map.of("fassung", offen.get(0).get("fassung")));
            }
            if (!offen.isEmpty()) {
                fassungId = (UUID) offen.get(0).get("id");
                n = (Integer) offen.get(0).get("fassung");
                jdbc.update("UPDATE bezugsbasis_fassung SET referenzperiode = ?, methode = ?, datenlage = ?, gilt_ab = ?, "
                        + "toleranz_prozent = ?, wiedervorlage_monate = ?, grundlage = ?, pruefsumme = ?, basiswert = ? "
                        + "WHERE id = ?", e.referenzperiode(), g.methode(), g.datenlage(), Date.valueOf(giltAb), toleranz,
                        wiedervorlage, g.text(), g.pruefsumme(), new BigDecimal(g.basiswert()), fassungId);
                jdbc.update("UPDATE bezugsbasis_variable SET aufgehoben_am = now() WHERE fassung_id = ? "
                        + "AND aufgehoben_am IS NULL", fassungId);
            } else {
                n = jdbc.queryForObject("SELECT coalesce(max(fassung), 0) + 1 FROM bezugsbasis_fassung "
                        + "WHERE bezugsbasis_id = ?", Integer.class, basisId);
                fassungId = jdbc.queryForObject("INSERT INTO bezugsbasis_fassung (tenant_id, bezugsbasis_id, fassung, "
                        + "referenzperiode, methode, datenlage, gilt_ab, toleranz_prozent, wiedervorlage_monate, grundlage, "
                        + "pruefsumme, basiswert, actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, ?, ?, ?, ?, "
                        + "?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", UUID.class, tenant, basisId, n,
                        e.referenzperiode(), g.methode(), g.datenlage(), Date.valueOf(giltAb), toleranz, wiedervorlage,
                        g.text(), g.pruefsumme(), new BigDecimal(g.basiswert()), wer.sub(), wer.name(), wer.rolle(),
                        wer.art());
            }
            // M4: Koeffizienten und Güte eingefroren an der Fassung (beim Verhältnis leer — ein neu gebildeter Entwurf
            // mit anderer Methode trägt keine alten Koeffizienten weiter).
            jdbc.update("UPDATE bezugsbasis_fassung SET koeffizienten = ?::jsonb, r2 = ?, streuung_prozent = ? WHERE id = ?",
                    modell == null ? null : alsJson(modell.koeffizienten()),
                    modell == null ? null : new BigDecimal(modell.r2()),
                    modell == null ? null : new BigDecimal(modell.streuungProzent()), fassungId);
            List<BezugsbasisGrundlage.Variable> vs = g.variablen();
            for (int i = 0; i < vs.size(); i++) {
                BezugsbasisGrundlage.Variable v = vs.get(i);
                jdbc.update("INSERT INTO bezugsbasis_variable (tenant_id, fassung_id, position, bezugsgroesse_id, "
                        + "bezugsgroesse_fassung, spannweite_von, spannweite_bis) VALUES (?, ?, ?, ?, ?, ?, ?)", tenant,
                        fassungId, i + 1, v.bezugsgroesseId(), v.fassung(), v.von(), v.bis());
            }
            Map<String, Object> inhalt = new LinkedHashMap<>();
            inhalt.put("referenzperiode", e.referenzperiode());
            inhalt.put("methode", g.methode());
            inhalt.put("datenlage", g.datenlage());
            inhalt.put("basiswert", g.basiswert());
            if (modell != null) {
                inhalt.put("koeffizienten", modell.koeffizienten());
                inhalt.put("r2", modell.r2());
                inhalt.put("streuung_prozent", modell.streuungProzent());
            }
            inhalt.put("pruefsumme", g.pruefsumme());
            protokoll(tenant, basisId, n, "fassung_entworfen", inhalt, wer);
            // G4: die abhängige zweite Variable ist nicht aufgenommen — der Versuch steht im Protokoll.
            for (Map<String, Object> a : modell == null ? List.<Map<String, Object>>of() : modell.abgelehnt()) {
                Map<String, Object> versuch = new LinkedHashMap<>(a);
                versuch.put("r", a.get("r").toString());
                versuch.put("startwert_r", a.get("startwert_r").toString());
                versuch.put("methode_gewuenscht", e.methode());
                protokoll(tenant, basisId, n, "variable_abgelehnt", versuch, wer);
            }
            return n;
        });
        return fassung(kennzahlId, basisId, nummer);
    }

    // ================================================================================ lesen

    public BezugsbasisDto.Bezugsbasis eine(UUID kennzahlId, UUID basisId) {
        KennzahlService.BasisKennzahl k = kennzahlen.fuerBezugsbasis(kennzahlId, null, null, null);
        Basis b = basis(kennzahlId, basisId);
        List<BezugsbasisDto.FassungKurz> fassungen = jdbc.query("SELECT " + FASSUNG_SPALTEN
                + " FROM bezugsbasis_fassung f WHERE f.bezugsbasis_id = ? ORDER BY f.fassung", (rs, i) -> fassungZeile(rs),
                basisId).stream().map(f -> new BezugsbasisDto.FassungKurz(f.fassung(), f.referenzperiode(), f.methode(),
                        f.datenlage(), f.freigabeStatus(), dezimal(f.basiswert()), f.giltAb(), f.giltBis(),
                        f.pruefsumme())).toList();
        return new BezugsbasisDto.Bezugsbasis(b.id(), b.kennzeichen(), b.kennzahlId(), k.zeile().kennzeichen(), b.zweck(),
                b.verantwortlichName(), b.beendetZum(), b.beendetGrund(), b.angelegtAm(), fassungen);
    }

    /** Die gespeicherte Fassung — dieselbe Antwort, die der Entwurf als Vorschau gab. */
    public BezugsbasisDto.Fassung fassung(UUID kennzahlId, UUID basisId, int nummer) {
        KennzahlService.BasisKennzahl k = kennzahlen.fuerBezugsbasis(kennzahlId, null, null, null);
        Basis b = basis(kennzahlId, basisId);
        FassungZeileDb f = jdbc.query("SELECT " + FASSUNG_SPALTEN + " FROM bezugsbasis_fassung f "
                + "WHERE f.bezugsbasis_id = ? AND f.fassung = ?", (rs, i) -> fassungZeile(rs), basisId, nummer)
                .stream().findFirst().orElseThrow(BezugsbasisAbgelehnt::nichtGefunden);
        JsonNode g = lies(f.grundlage());
        List<BezugsbasisDto.Variable> variablen = jdbc.query("SELECT v.position, v.bezugsgroesse_id, z.kennzeichen, "
                + "v.bezugsgroesse_fassung, v.spannweite_von, v.spannweite_bis FROM bezugsbasis_variable v "
                + "JOIN bezugsgroesse z ON z.id = v.bezugsgroesse_id WHERE v.fassung_id = ? AND v.aufgehoben_am IS NULL "
                + "ORDER BY v.position", (rs, i) -> new BezugsbasisDto.Variable(rs.getInt("position"),
                        rs.getInt("position") == 1 ? "nenner" : "variable", rs.getObject("bezugsgroesse_id", UUID.class),
                        rs.getString("kennzeichen"), rs.getObject("bezugsgroesse_fassung", Integer.class),
                        dezimal(rs.getBigDecimal("spannweite_von")), dezimal(rs.getBigDecimal("spannweite_bis"))), f.id());
        return new BezugsbasisDto.Fassung(b.id(), b.kennzeichen(), b.kennzahlId(), k.zeile().kennzeichen(), f.fassung(),
                f.referenzperiode(), f.methode(), f.giltAb(), g.path("monate").asInt(),
                g.path("mindest_monate").asInt(BezugsbasisRegeln.STARTWERTE.mindest_monate()), f.datenlage(),
                json.convertValue(g.path("datenlage_gruende"), new TypeReference<List<Map<String, Object>>>() {}),
                json.convertValue(g.path("vorbehalte"), new TypeReference<List<String>>() {}), dezimal(f.basiswert()),
                f.koeffizienten() == null ? null : json.convertValue(lies(f.koeffizienten()),
                        new TypeReference<Map<String, String>>() {}), f.r2() == null ? null : f.r2().toPlainString(),
                f.streuung() == null ? null : f.streuung().toPlainString(),
                json.convertValue(g.path("abgelehnte_variablen").isMissingNode() ? json.createArrayNode()
                        : g.path("abgelehnte_variablen"), new TypeReference<List<Map<String, Object>>>() {}),
                json.convertValue(g.path("kennzeichen").isMissingNode() ? json.createArrayNode() : g.path("kennzeichen"),
                        new TypeReference<List<String>>() {}),
                dezimal(f.toleranz()), f.wiedervorlage(), variablen, List.of(), f.freigabeStatus(), f.angelegtAm(),
                f.actorName(), f.grundlage(), f.pruefsumme());
    }

    // ================================================================================ Prüfungen

    /**
     * B2: nur ein Quotient mit einer Energie-Menge (Messstelle) im Zähler oder eine Zusammenfassung (nur Verhältnis);
     * ein Anteil nie. Liefert den Nenner als Bezugsgröße (Variable 1, V2) oder {@code null}.
     */
    private static EingangZeile traeger(KennzahlService.BasisKennzahl k, String methode) {
        FassungZeile f = k.fassung();
        if (f == null) {
            return null;
        }
        if (KennzahlRegeln.ZUSAMMENFASSUNG.equals(f.rechenform())) {
            return null;
        }
        EingangZeile zaehler = k.eingaenge().stream().filter(x -> "zaehler".equals(x.rolle())).findFirst().orElse(null);
        if (!"quotient".equals(f.rechenform()) || zaehler == null || !KennzahlRegeln.MESSSTELLE.equals(zaehler.art())) {
            throw BezugsbasisAbgelehnt.fachlich("kennzahl_ohne_bezugsbasis", "Eine Bezugsbasis tragen nur Kennzahlen, "
                    + "die Energie durch eine Bezugsgröße teilen, und Zusammenfassungen.",
                    Map.of("rechenform", f.rechenform()));
        }
        return k.eingaenge().stream().filter(x -> "nenner".equals(x.rolle()) && "bezugsgroesse".equals(x.art()))
                .findFirst().orElse(null);
    }

    /**
     * V2/V5: höchstens zwei; Variable 1 ist immer der Nenner der Kennzahl (darf fehlen oder vorn stehen). Verhältnis,
     * Modell mit einer Einflussgröße und Gradtage rechnen nur mit ihm; das Modell mit zwei Einflussgrößen verlangt genau
     * eine weitere Bezugsgröße. Liefert deren Kennung oder {@code null}.
     */
    private static UUID variablen(String methode, List<String> gewuenscht, EingangZeile nenner) {
        List<String> liste = gewuenscht == null ? List.of() : gewuenscht;
        if (liste.size() > 2) {
            throw BezugsbasisAbgelehnt.fachlich("zu_viele_variablen", "Höchstens zwei Einflussgrößen je Fassung.",
                    Map.of("hoechstens", 2));
        }
        if (!VERHAELTNIS.equals(methode) && nenner == null) {
            throw BezugsbasisAbgelehnt.fachlich("modell_ohne_nenner", "Ein Modell rechnet mit dem Nenner der Kennzahl "
                    + "als Einflussgröße; eine Zusammenfassung hat keinen und rechnet als Verhältnis.",
                    Map.of("methode", methode));
        }
        String erste = nenner == null ? null : nenner.objektId().toString();
        List<String> weitere = new java.util.ArrayList<>(liste);
        if (!weitere.isEmpty() && weitere.get(0).equals(erste)) {
            weitere.remove(0);
        }
        if (!ZWEI_VARIABLEN.equals(methode)) {
            if (!weitere.isEmpty()) {
                throw BezugsbasisAbgelehnt.fachlich("variable_nicht_nenner", VERHAELTNIS.equals(methode)
                        ? "Das Verhältnis rechnet mit genau einer Größe: dem Nenner der Kennzahl."
                        : "Diese Methode rechnet mit genau einer Einflussgröße: dem Nenner der Kennzahl.",
                        nenner == null ? Map.of() : Map.of("nenner", nenner.kennzeichen()));
            }
            return null;
        }
        if (weitere.size() != 1) {
            throw BezugsbasisAbgelehnt.fachlich("zweite_variable_fehlt", "Ein Modell mit zwei Einflussgrößen braucht "
                    + "neben dem Nenner genau eine weitere Bezugsgröße.", Map.of("nenner", nenner.kennzeichen()));
        }
        try {
            UUID id = UUID.fromString(weitere.get(0));
            if (!id.toString().equals(erste)) {
                return id;
            }
        } catch (IllegalArgumentException x) {
            // fällt durch zur Ablehnung
        }
        throw BezugsbasisAbgelehnt.fachlich("variable_unbekannt", "Diese Bezugsgröße gibt es hier nicht.",
                Map.of("variable", weitere.get(0)));
    }

    /** Die Art einer Bezugsgröße (M3: {@code gradtagzahl}) — {@code null}, wenn sie keine trägt. */
    private String art(UUID bezugsgroesse) {
        return jdbc.query("SELECT to_jsonb(b)->>'art' AS art FROM bezugsgroesse b WHERE b.id = ?",
                (rs, i) -> rs.getString("art"), bezugsgroesse).stream().filter(Objects::nonNull).findFirst().orElse(null);
    }

    /**
     * Variable 2 (V1, V5): eine sichtbare Bezugsgröße mit Periodenwerten; je Monat die Summe ihrer wirksamen Werte im
     * Monat mit der Fassung (bei einem Wert je Monat). Ein Monat, in dem ein Teilwert fehlt, fehlt ganz — keine Null.
     */
    private BezugsbasisGrundlage.ZweiteVariable zweite(UUID id, YearMonth von, YearMonth bis) {
        if (jdbc.queryForObject("SELECT count(*) FROM bezugsgroesse WHERE id = ?", Integer.class, id) == 0) {
            throw BezugsbasisAbgelehnt.fachlich("variable_unbekannt", "Diese Bezugsgröße gibt es hier nicht.",
                    Map.of("variable", id.toString()));
        }
        rechte.pruefenLesen(RechtZiel.BEZUGSGROESSE, id, () -> BezugsbasisAbgelehnt.fachlich("variable_unbekannt",
                "Diese Bezugsgröße gibt es hier nicht.", Map.of("variable", id.toString())));
        BezugsgroesseDto.Werte werte = bezugsgroessen.werte(id, von.atDay(1), bis.atEndOfMonth(),
                BezugsgroesseRegeln.LESARTEN.get(0));
        if (!KennzahlRegeln.PERIODENWERT.equals(werte.wertart())) {
            throw BezugsbasisAbgelehnt.fachlich("variable_ohne_periodenwerte", "Eine Einflussgröße braucht Werte je "
                    + "Periode; ein Stammdatum ist ein statischer Faktor.", Map.of("variable", werte.kennzeichen()));
        }
        Map<YearMonth, BezugsbasisGrundlage.Monatswert> jeMonat = new LinkedHashMap<>();
        for (YearMonth m = von; !m.isAfter(bis); m = m.plusMonths(1)) {
            java.util.Set<String> erwartet = new java.util.LinkedHashSet<>();
            for (LocalDate t = m.atDay(1); !t.isAfter(m.atEndOfMonth()); t = t.plusDays(1)) {
                erwartet.add(BezugsPeriode.schluesselVon(t, werte.periodeArt()));
            }
            Map<String, BezugsgroesseDto.Wert> jeSchluessel = new LinkedHashMap<>();
            for (BezugsgroesseDto.Wert w : werte.werte()) {
                if (w.periodeVon() != null && !w.periodeVon().isBefore(m.atDay(1))
                        && (w.periodeBis() == null || !w.periodeBis().isAfter(m.atEndOfMonth()))) {
                    jeSchluessel.put(BezugsPeriode.schluesselVon(w.periodeVon(), werte.periodeArt()), w);
                }
            }
            BigDecimal summe = BigDecimal.ZERO;
            boolean da = true;
            for (String schluessel : erwartet) {
                BezugsgroesseDto.Wert w = jeSchluessel.get(schluessel);
                if (w == null || w.wirksamerBetrag() == null) {
                    da = false;
                    break;
                }
                summe = summe.add(new BigDecimal(w.wirksamerBetrag()));
            }
            if (da) {
                BezugsgroesseDto.Wert einer = erwartet.size() == 1 ? jeSchluessel.get(erwartet.iterator().next()) : null;
                List<String> kennzeichen = einer == null || einer.fassungen() == null ? List.of() : einer.fassungen()
                        .stream().filter(f -> Objects.equals(f.fassung(), einer.wirksameFassung()))
                        .map(BezugsgroesseDto.Fassung::kennzeichen).filter(Objects::nonNull).findFirst()
                        .orElse(List.of());
                jeMonat.put(m, new BezugsbasisGrundlage.Monatswert(summe, einer == null ? null
                        : einer.wirksameFassung(), kennzeichen));
            }
        }
        return new BezugsbasisGrundlage.ZweiteVariable(id, werte.kennzeichen(), werte.einheit(), jeMonat);
    }

    private static BigDecimal toleranz(String text) {
        if (text == null) {
            return new BigDecimal(BezugsbasisRegeln.STARTWERTE.toleranz_prozent());
        }
        try {
            BigDecimal t = new BigDecimal(text);
            if (t.signum() > 0 && t.compareTo(BigDecimal.valueOf(100)) < 0) {
                return t;
            }
        } catch (NumberFormatException x) {
            // fällt durch zur Ablehnung
        }
        throw BezugsbasisAbgelehnt.fachlich("toleranz_ungueltig", "Die Toleranz ist ein Prozentwert über 0 und unter 100.",
                Map.of("toleranz_prozent", text));
    }

    private static BezugsbasisAbgelehnt keineWerte(String referenzperiode) {
        return BezugsbasisAbgelehnt.fachlich("keine_werte",
                "In der Referenzperiode hat die Kennzahl keinen gespeicherten Monatswert.",
                Map.of("referenzperiode", referenzperiode));
    }

    private static BezugsbasisAbgelehnt laeuft(Basis b) {
        return new BezugsbasisAbgelehnt(409, "bezugsbasis_laeuft",
                "Diese Kennzahl hat schon eine laufende Bezugsbasis; bilden Sie dort eine neue Fassung.",
                Map.of("bezugsbasis_id", b.id().toString(), "bezugsbasis", b.kennzeichen()));
    }

    // ================================================================================ Gerüst

    private java.util.Optional<Basis> laufende(UUID kennzahlId) {
        return jdbc.query("SELECT " + BASIS_SPALTEN + " FROM bezugsbasis b WHERE b.kennzahl_id = ? "
                + "AND b.beendet_am IS NULL", (rs, i) -> basisZeile(rs), kennzahlId).stream().findFirst();
    }

    private Basis basis(UUID kennzahlId, UUID basisId) {
        return jdbc.query("SELECT " + BASIS_SPALTEN + " FROM bezugsbasis b WHERE b.id = ? AND b.kennzahl_id = ?",
                (rs, i) -> basisZeile(rs), basisId, kennzahlId).stream().findFirst()
                .orElseThrow(BezugsbasisAbgelehnt::nichtGefunden);
    }

    private void protokoll(UUID tenant, UUID basis, Integer fassung, String art, Map<String, Object> neu,
            ProtokollAkteur wer) {
        try {
            jdbc.update("INSERT INTO bezugsbasis_aenderung (tenant_id, bezugsbasis_id, fassung, art, neu, actor_sub, "
                    + "actor_name, actor_rolle, actor_art) VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?)", tenant, basis,
                    fassung, art, json.writeValueAsString(neu), wer.sub(), wer.name(), wer.rolle(), wer.art());
        } catch (com.fasterxml.jackson.core.JsonProcessingException x) {
            throw new IllegalStateException(x);
        }
    }

    private String alsJson(Object o) {
        try {
            return json.writeValueAsString(o);
        } catch (com.fasterxml.jackson.core.JsonProcessingException x) {
            throw new IllegalStateException(x);
        }
    }

    private JsonNode lies(String text) {
        try {
            return text == null ? json.createObjectNode() : json.readTree(text);
        } catch (com.fasterxml.jackson.core.JsonProcessingException x) {
            throw new IllegalStateException(x);
        }
    }

    private static String dezimal(BigDecimal d) {
        return d == null ? null : d.stripTrailingZeros().toPlainString();
    }

    private static Basis basisZeile(ResultSet rs) throws SQLException {
        Date zum = rs.getDate("beendet_zum");
        return new Basis(rs.getObject("id", UUID.class), rs.getString("kennzeichen"),
                rs.getObject("kennzahl_id", UUID.class), rs.getString("zweck"), rs.getString("verantwortlich_name"),
                zum == null ? null : zum.toLocalDate(), zeit(rs, "beendet_am"), rs.getString("beendet_grund"),
                zeit(rs, "created_at"));
    }

    private static FassungZeileDb fassungZeile(ResultSet rs) throws SQLException {
        Date bis = rs.getDate("gilt_bis");
        return new FassungZeileDb(rs.getObject("id", UUID.class), rs.getInt("fassung"), rs.getString("referenzperiode"),
                rs.getString("methode"), rs.getString("datenlage"), rs.getDate("gilt_ab").toLocalDate(),
                bis == null ? null : bis.toLocalDate(), rs.getBigDecimal("toleranz_prozent"),
                rs.getInt("wiedervorlage_monate"), rs.getString("grundlage"), rs.getString("pruefsumme"),
                rs.getBigDecimal("basiswert"), rs.getString("freigabe_status"), rs.getString("actor_name"),
                zeit(rs, "created_at"), rs.getString("koeffizienten"), rs.getBigDecimal("r2"),
                rs.getBigDecimal("streuung_prozent"));
    }

    private static OffsetDateTime zeit(ResultSet rs, String spalte) throws SQLException {
        java.sql.Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant().atOffset(ZoneOffset.UTC);
    }
}
