package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.KennzahlRepository.EingangZeile;
import com.voltpilot.api.uems.KennzahlRepository.FassungZeile;
import com.voltpilot.api.web.dto.BezugsbasisDto;
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
 * Entwurf neu (gleiche Nummer); freigegeben, beantragt oder abgelehnt wird hier nichts (IP-8). Gebaut ist nur die
 * Methode Verhältnis; die Modelle kommen mit IP-10.
 */
@Service
public class BezugsbasisService {

    static final String VERWALTEN = "bezugsbasis.verwalten";
    static final String VERHAELTNIS = "verhaeltnis";

    private static final String BASIS_SPALTEN = "b.id, b.kennzeichen, b.kennzahl_id, b.zweck, b.verantwortlich_name, "
            + "b.beendet_zum, b.beendet_am, b.beendet_grund, b.created_at";
    private static final String FASSUNG_SPALTEN = "f.id, f.fassung, f.referenzperiode, f.methode, f.datenlage, f.gilt_ab, "
            + "f.gilt_bis, f.toleranz_prozent, f.wiedervorlage_monate, f.grundlage, f.pruefsumme, f.basiswert, "
            + "f.freigabe_status, f.actor_name, f.created_at";

    private final KennzahlService kennzahlen;
    private final JdbcTemplate jdbc;
    private final BezugsbasisGrundlage grundlage;
    private final TransactionTemplate transaktion;
    private final ObjectMapper json;

    public BezugsbasisService(KennzahlService kennzahlen, JdbcTemplate jdbc, PlatformTransactionManager transactionManager,
            ObjectMapper json) {
        this.kennzahlen = kennzahlen;
        this.jdbc = jdbc;
        this.grundlage = new BezugsbasisGrundlage(jdbc);
        this.transaktion = new TransactionTemplate(transactionManager);
        this.json = json;
    }

    private record Basis(UUID id, String kennzeichen, UUID kennzahlId, String zweck, String verantwortlichName,
            LocalDate beendetZum, OffsetDateTime beendetAm, String beendetGrund, OffsetDateTime angelegtAm) {}

    private record FassungZeileDb(UUID id, int fassung, String referenzperiode, String methode, String datenlage,
            LocalDate giltAb, LocalDate giltBis, BigDecimal toleranz, int wiedervorlage, String grundlage,
            String pruefsumme, BigDecimal basiswert, String freigabeStatus, String actorName, OffsetDateTime angelegtAm) {}

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
        if (!VERHAELTNIS.equals(e.methode())) {
            throw BezugsbasisAbgelehnt.fachlich("methode_noch_nicht_gebaut",
                    "Diese Methode ist noch nicht verfügbar; bis dahin rechnet die Bezugsbasis als Verhältnis.",
                    Map.of("methode", e.methode(), "gebaut", List.of(VERHAELTNIS)));
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
        variablen(e.variablen(), nenner);
        BezugsbasisGrundlage.Ergebnis g = grundlage.bilden(kennzahlId, k.zeile().kennzeichen(), k.fassung().rechenform(),
                k.fassung().nummer(), e.referenzperiode(), von, bis, e.methode(),
                nenner == null ? null : nenner.objektId(), nenner == null ? null : nenner.kennzeichen());
        if (g.basiswert() == null) {
            throw keineWerte(e.referenzperiode());
        }

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
                        + "WHERE id = ?", e.referenzperiode(), e.methode(), g.datenlage(), Date.valueOf(giltAb), toleranz,
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
                        e.referenzperiode(), e.methode(), g.datenlage(), Date.valueOf(giltAb), toleranz, wiedervorlage,
                        g.text(), g.pruefsumme(), new BigDecimal(g.basiswert()), wer.sub(), wer.name(), wer.rolle(),
                        wer.art());
            }
            BezugsbasisGrundlage.Variable v = g.variable();
            if (v != null) {
                jdbc.update("INSERT INTO bezugsbasis_variable (tenant_id, fassung_id, position, bezugsgroesse_id, "
                        + "bezugsgroesse_fassung, spannweite_von, spannweite_bis) VALUES (?, ?, 1, ?, ?, ?, ?)", tenant,
                        fassungId, v.bezugsgroesseId(), v.fassung(), v.von(), v.bis());
            }
            Map<String, Object> inhalt = new LinkedHashMap<>();
            inhalt.put("referenzperiode", e.referenzperiode());
            inhalt.put("methode", e.methode());
            inhalt.put("datenlage", g.datenlage());
            inhalt.put("basiswert", g.basiswert());
            inhalt.put("pruefsumme", g.pruefsumme());
            protokoll(tenant, basisId, n, "fassung_entworfen", inhalt, wer);
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

    /** V2/V5: höchstens zwei; beim Verhältnis genau der Nenner der Kennzahl (Variable 1). */
    private static void variablen(List<String> gewuenscht, EingangZeile nenner) {
        if (gewuenscht == null) {
            return;
        }
        if (gewuenscht.size() > 2) {
            throw BezugsbasisAbgelehnt.fachlich("zu_viele_variablen", "Höchstens zwei Einflussgrößen je Fassung.",
                    Map.of("hoechstens", 2));
        }
        boolean nurNenner = gewuenscht.isEmpty()
                || (gewuenscht.size() == 1 && nenner != null && nenner.objektId().toString().equals(gewuenscht.get(0)));
        if (!nurNenner) {
            throw BezugsbasisAbgelehnt.fachlich("variable_nicht_nenner",
                    "Das Verhältnis rechnet mit genau einer Größe: dem Nenner der Kennzahl.",
                    nenner == null ? Map.of() : Map.of("nenner", nenner.kennzeichen()));
        }
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
                zeit(rs, "created_at"));
    }

    private static OffsetDateTime zeit(ResultSet rs, String spalte) throws SQLException {
        java.sql.Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant().atOffset(ZoneOffset.UTC);
    }
}
