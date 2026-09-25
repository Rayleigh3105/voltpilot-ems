package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.BezugsbasisVergleichDto;
import com.voltpilot.api.web.dto.MassnahmeDto;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.sql.Date;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Die Maßnahme (UEMS AP-18 IP-10, M1–M4, M6, M7, RE1–RE3, E2 = A): anlegen, lesen, ändern solange geplant,
 * Verantwortlicher, umgesetzt melden, verwerfen, Kommentare — jede Änderung eine Zeile im Protokoll
 * {@code massnahme_aenderung}. Die Tabellen und ihre Trigger bringt IP-9; hier stehen nur die Schreibwege.
 *
 * <p><b>M2 Messgrundlage:</b> Kennzahl × die freigegebene, heute geltende Bezugsbasis-Fassung × die gewählten Monate;
 * die Ausgangslage ist eine KOPIE dessen, was der Vergleich-Leser ({@link BezugsbasisVergleich#fuerZiel}) für diese
 * Monate liefert — kanonischer Text ({@link BerichtRegeln#kanonisch}) mit {@code sha256:}-Prüfsumme, dieselbe wie
 * {@code bericht_pruefsumme}. Gerechnet wird hier nichts; eine zweite Bildung ist byte-gleich. Ohne Monate gilt der
 * letzte abgeschlossene Monat (der Anlass einer Abweichung kommt mit IP-14/IP-16).
 *
 * <p><b>M4 ohne Messgrundlage:</b> erlaubt; eine Zahl der erwarteten Wirkung ist dann 422 {@code ohne_messgrundlage},
 * der Wortlaut bleibt Pflicht; die Maßnahme trägt „ohne Messgrundlage — Wirkung nicht messbar“ mit dem Hinweis, welche
 * Kennzahl fehlt (aus Träger und Einflussgröße des Einsatzes, sonst allgemein).
 *
 * <p><b>Zaun (RE2):</b> der Standort folgt der Kennzahl ({@link KennzahlService#fuerBezugsbasis}, 404/403), ohne
 * Kennzahl ist er gewählt (ohne Standort = Unternehmen); das Recht {@code verbesserung.verwalten} prüft
 * {@link KennzahlService#darf} an diesem Standort (BE S am eigenen Standort, BD/LE 403). Sichtbarkeit über RLS
 * {@code site_scope} auf {@code standort_id} und über die Kennzahl — außerhalb 404. Der Kundenbereich kommt nie aus dem
 * Körper. Verantwortung verleiht kein Recht (RE3): der Verantwortliche ist nur ein aktives Konto.
 *
 * <p><b>F1:</b> „überfällig“ ist abgeleitet über die Operation {@code frist} mit der Uhr der Kennzahlen — kein
 * Läufer, kein Zustand.
 */
@Service
public class MassnahmeService {

    static final String VERWALTEN = "verbesserung.verwalten";
    static final Set<String> LISTE_PARAMETER = Set.of("zustand", "ueberfaellig", "kennzahl", "einsatz");
    /** Die Ausgangslage umfasst höchstens ein Jahr. */
    static final int AUSGANGSLAGE_HOECHSTENS_MONATE = 12;
    static final String OHNE_KENNZEICHEN = "ohne Messgrundlage — Wirkung nicht messbar";
    private static final String GEPLANT = "geplant";
    private static final Pattern MONAT = Pattern.compile("\\d{4}-(0[1-9]|1[0-2])");
    private static final Pattern ABWEICHUNG = Pattern.compile("AW-[0-9]{4}-[0-9]{4,9}");
    /** Die Kennungen der Herkünfte aus dem Energiemanagement (AP-19 W4; {@code kennzeichen_muster} des Vertrags). */
    private static final Map<String, Pattern> ENERGIEMANAGEMENT_HERKUNFT = Map.of(
            "nichtkonformitaet", Pattern.compile("F-[0-9]{4}-[0-9]{4,9}"),
            "audit", Pattern.compile("AU-[0-9]{4}-[0-9]{4,9}"),
            "managementbewertung", Pattern.compile("BR-[0-9]{4}-[0-9]{4,}/B[0-9]{1,3}"));
    private static final DateTimeFormatter TAG = DateTimeFormatter.ofPattern("dd.MM.yyyy");
    /** Die Methoden der Bezugsbasis in Kundenwörtern (SP1, wie {@code BerichtPdf}). */
    private static final Map<String, String> METHODEN = Map.of("verhaeltnis", "Verhältnis",
            "regression_eine_variable", "Modell mit einer Einflussgröße", "regression_zwei_variablen",
            "Modell mit zwei Einflussgrößen", "gradtage", "Gradtage (G20/15)");

    private final KennzahlService kennzahlen;
    private final BezugsbasisVergleich vergleich;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaktion;
    private final ObjectMapper json;

    public MassnahmeService(KennzahlService kennzahlen, BezugsbasisVergleich vergleich, JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager, ObjectMapper json) {
        this.kennzahlen = kennzahlen;
        this.vergleich = vergleich;
        this.jdbc = jdbc;
        this.transaktion = new TransactionTemplate(transactionManager);
        this.json = json;
    }

    private static final String SPALTEN = "SELECT m.*, k.kennzeichen AS kz, k.name AS kz_name, b.kennzeichen AS bb, "
            + "f.methode AS methode, e.kennzeichen AS ee, e.name AS ee_name, e.traeger AS ee_traeger, "
            + "z.kennzeichen AS ez, z.wortlaut AS ez_wortlaut FROM massnahme m "
            + "LEFT JOIN kennzahl k ON k.id = m.kennzahl_id AND k.tenant_id = m.tenant_id "
            + "LEFT JOIN bezugsbasis b ON b.id = m.bezugsbasis_id AND b.tenant_id = m.tenant_id "
            + "LEFT JOIN bezugsbasis_fassung f ON f.bezugsbasis_id = m.bezugsbasis_id AND f.tenant_id = m.tenant_id "
            + "AND f.fassung = m.fassung "
            + "LEFT JOIN energieeinsatz e ON e.id = m.einsatz_id AND e.tenant_id = m.tenant_id "
            + "LEFT JOIN energieziel z ON z.id = m.energieziel_id AND z.tenant_id = m.tenant_id ";

    // ================================================================================ lesen

    /** Das Register im Zaun; Filter Zustand, überfällig (Operation {@code frist}), Kennzahl, Einsatz. */
    public MassnahmeDto.Liste liste(Collection<String> parameter, String zustand, String ueberfaellig,
            String kennzahlText, String einsatzText) {
        parameter.stream().filter(p -> !LISTE_PARAMETER.contains(p)).findFirst().ifPresent(p -> {
            throw VerbesserungAbgelehnt.anfrage(p);
        });
        StringBuilder sql = new StringBuilder(SPALTEN).append("WHERE true ");
        List<Object> args = new ArrayList<>();
        if (zustand != null) {
            if (!VerbesserungRegeln.VOKABULARE.get("massnahme_zustand").contains(zustand)) {
                throw VerbesserungAbgelehnt.anfrage("zustand");
            }
            sql.append("AND m.zustand = ? ");
            args.add(zustand);
        }
        Boolean nurUeberfaellig = null;
        if (ueberfaellig != null) {
            if (!ueberfaellig.equals("true") && !ueberfaellig.equals("false")) {
                throw VerbesserungAbgelehnt.anfrage("ueberfaellig");
            }
            nurUeberfaellig = Boolean.valueOf(ueberfaellig);
        }
        if (kennzahlText != null) {
            UUID kennzahl = uuid(kennzahlText, "kennzahl");
            kennzahlen.fuerBezugsbasis(kennzahl, null, null, null);
            sql.append("AND m.kennzahl_id = ? ");
            args.add(kennzahl);
        }
        if (einsatzText != null) {
            sql.append("AND m.einsatz_id = ? ");
            args.add(uuid(einsatzText, "einsatz"));
        }
        sql.append("ORDER BY m.kennzeichen");
        ZoneId zone = zone();
        LocalDate abruf = LocalDate.ofInstant(kennzahlen.jetzt(), zone);
        Map<UUID, Boolean> lesbar = new HashMap<>();
        List<MassnahmeDto.Massnahme> aus = new ArrayList<>();
        for (Map<String, Object> z : jdbc.queryForList(sql.toString(), args.toArray())) {
            UUID kz = (UUID) z.get("kennzahl_id");
            if (kz != null && !lesbar.computeIfAbsent(kz, x -> kennzahlen.lesbareKennzahlOderNichts(x) != null)) {
                continue;
            }
            MassnahmeDto.Massnahme m = dto(z, zone, abruf, null);
            if (nurUeberfaellig != null && nurUeberfaellig != "ueberfaellig".equals(m.frist().faellig())) {
                continue;
            }
            aus.add(m);
        }
        return new MassnahmeDto.Liste(abruf, List.copyOf(aus));
    }

    /** Die Maßnahme mit Verlauf; Sichtbarkeit über RLS ({@code site_scope}) und über ihre Kennzahl — sonst 404. */
    public MassnahmeDto.Massnahme eine(UUID id) {
        Map<String, Object> z = sichtbar(id);
        ZoneId zone = zone();
        return dto(z, zone, LocalDate.ofInstant(kennzahlen.jetzt(), zone), verlauf(id));
    }

    /** Die Maßnahme ohne Verlauf — der Kopf der Wirkung (IP-11); Sichtbarkeit wie {@link #eine} (404). */
    public MassnahmeDto.Massnahme ohneVerlauf(UUID id) {
        Map<String, Object> z = sichtbar(id);
        ZoneId zone = zone();
        return dto(z, zone, LocalDate.ofInstant(kennzahlen.jetzt(), zone), null);
    }

    // ================================================================================ anlegen (M1–M4)

    public MassnahmeDto.Massnahme anlegen(MassnahmeDto.Anlegen a, ProtokollAkteur wer) {
        if (a == null) {
            throw VerbesserungAbgelehnt.anfrage("");
        }
        String titel = pflichttext(a.titel(), "titel_fehlt", "Eine Maßnahme hat einen Titel.");
        if (a.termin() == null) {
            throw VerbesserungAbgelehnt.anfrage("termin");
        }
        String wortlaut = pflichttext(a.erwarteteWirkungWortlaut(), "wortlaut_fehlt",
                "Die erwartete Wirkung steht immer in Worten — auch ohne Messgrundlage.");
        String herkunft = a.herkunft() == null ? "von_hand" : a.herkunft();
        if (!VerbesserungRegeln.VOKABULARE.get("massnahme_herkunft").contains(herkunft)) {
            throw VerbesserungAbgelehnt.anfrage("herkunft");
        }
        Map<String, Object> einsatz = a.einsatz() == null ? null : einsatz(a.einsatz());
        Map<String, Object> ziel = a.energieziel() == null ? null : energieziel(a.energieziel());
        if (a.einstufungFassung() != null && einsatz == null) {
            throw VerbesserungAbgelehnt.anfrage("einstufung_fassung");
        }
        String kennung = switch (herkunft) {
            case "abweichung" -> {
                if (a.herkunftKennung() == null || !ABWEICHUNG.matcher(a.herkunftKennung()).matches()) {
                    throw VerbesserungAbgelehnt.anfrage("herkunft_kennung");
                }
                yield a.herkunftKennung();
            }
            case "energieziel" -> (String) verweisPflicht(ziel, "energieziel").get("kennzeichen");
            case "einsatz" -> (String) verweisPflicht(einsatz, "einsatz").get("kennzeichen");
            case "nichtkonformitaet", "audit", "managementbewertung" -> {
                if (a.herkunftKennung() == null
                        || !ENERGIEMANAGEMENT_HERKUNFT.get(herkunft).matcher(a.herkunftKennung()).matches()) {
                    throw VerbesserungAbgelehnt.anfrage("herkunft_kennung");
                }
                yield a.herkunftKennung();
            }
            default -> {
                if (a.herkunftKennung() != null) {
                    throw VerbesserungAbgelehnt.anfrage("herkunft_kennung");
                }
                yield null;
            }
        };

        Messgrundlage mg = null;
        UUID standort;
        if (a.kennzahl() != null) {
            mg = messgrundlage(a.kennzahl(), a.monate(), wer);
            standort = mg.standort();
            if (a.standort() != null && !a.standort().equals(standort)) {
                throw VerbesserungAbgelehnt.fachlich("standort_der_kennzahl", "Der Standort einer Maßnahme mit "
                        + "Messgrundlage ist der Standort ihrer Kennzahl.", Map.of("feld", "standort"));
            }
        } else {
            if (a.monate() != null) {
                throw VerbesserungAbgelehnt.anfrage("monate");
            }
            if (a.erwarteteWirkungProzent() != null) {
                throw ohneMessgrundlage(einsatz);
            }
            standort = a.standort();
            darfAm(standort, wer, VERWALTEN);
        }
        BigDecimal prozent = prozent(a.erwarteteWirkungProzent());
        Map<String, Object> person = verantwortlich(a.verantwortlich());
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        Instant jetzt = kennzahlen.jetzt();
        Messgrundlage m = mg;
        UUID neu = schreiben(() -> transaktion.execute(s -> {
            herkunftPruefen(herkunft, kennung);
            UUID id = jdbc.queryForObject("INSERT INTO massnahme (tenant_id, titel, verantwortlich_sub, "
                    + "verantwortlich_name, verantwortlich_konto, termin, standort_id, herkunft_art, herkunft_kennung, "
                    + "kennzahl_id, bezugsbasis_id, fassung, ausgangslage, ausgangslage_pruefsumme, einsatz_id, "
                    + "einstufung_fassung, energieziel_id, erwartete_wirkung_prozent, erwartete_wirkung_wortlaut, "
                    + "actor_sub, actor_name, actor_rolle, actor_art, angelegt_am) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, "
                    + "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id", UUID.class, tenant, titel,
                    person.get("sub"), person.get("name"), person.get("konto"), Date.valueOf(a.termin()), standort,
                    herkunft, kennung, m == null ? null : m.kennzahl(), m == null ? null : m.basis(),
                    m == null ? null : m.fassung(), m == null ? null : m.text(), m == null ? null : m.pruefsumme(),
                    a.einsatz(), a.einstufungFassung(), a.energieziel(), prozent, wortlaut, wer.sub(), wer.name(),
                    wer.rolle(), wer.art(), Timestamp.from(jetzt));
            Map<String, Object> inhalt = new LinkedHashMap<>();
            inhalt.put("zustand", GEPLANT);
            inhalt.put("titel", titel);
            inhalt.put("termin", a.termin().toString());
            inhalt.put("verantwortlich_name", person.get("name"));
            inhalt.put("herkunft", herkunft);
            if (kennung != null) {
                inhalt.put("herkunft_kennung", kennung);
            }
            if (m != null) {
                inhalt.put("kennzahl", m.kennzahlKennzeichen());
                inhalt.put("bezugsbasis", m.basisKennzeichen());
                inhalt.put("fassung", m.fassung());
                inhalt.put("ausgangslage_pruefsumme", m.pruefsumme());
            } else {
                inhalt.put("messgrundlage", OHNE_KENNZEICHEN);
            }
            if (prozent != null) {
                inhalt.put("erwartete_wirkung_prozent", prozent.toPlainString());
            }
            protokoll(tenant, id, "massnahme_angelegt", null, inhalt, null, null, wer);
            return id;
        }));
        return eine(neu);
    }

    // ================================================================================ ändern, Verantwortlicher

    /** §5.7/M2/M6: Titel, Termin, Messgrundlage (neue Kopie), erwartete Wirkung — solange geplant, mit Begründung. */
    public MassnahmeDto.Massnahme aendern(UUID id, MassnahmeDto.Aendern a, ProtokollAkteur wer) {
        Map<String, Object> z = geplant(schreibbar(id, wer));
        if (a == null || (a.titel() == null && a.termin() == null && a.erwarteteWirkungProzent() == null
                && a.erwarteteWirkungWortlaut() == null)) {
            throw VerbesserungAbgelehnt.anfrage("");
        }
        String begruendung = begruendung(a.begruendung());
        String titel = a.titel() == null ? (String) z.get("titel")
                : pflichttext(a.titel(), "titel_fehlt", "Eine Maßnahme hat einen Titel.");
        LocalDate termin = a.termin() == null ? ((Date) z.get("termin")).toLocalDate() : a.termin();
        String wortlaut = a.erwarteteWirkungWortlaut() == null ? (String) z.get("erwartete_wirkung_wortlaut")
                : pflichttext(a.erwarteteWirkungWortlaut(), "wortlaut_fehlt",
                        "Die erwartete Wirkung steht immer in Worten — auch ohne Messgrundlage.");
        BigDecimal altProzent = (BigDecimal) z.get("erwartete_wirkung_prozent");
        BigDecimal prozent = altProzent;
        if (a.erwarteteWirkungProzent() != null) {
            if (z.get("kennzahl_id") == null) {
                throw ohneMessgrundlage(z.get("einsatz_id") == null ? null : einsatz((UUID) z.get("einsatz_id")));
            }
            prozent = prozent(a.erwarteteWirkungProzent());
        }
        Map<String, Object> alt = new LinkedHashMap<>();
        Map<String, Object> neu = new LinkedHashMap<>();
        vergleiche(alt, neu, "titel", z.get("titel"), titel);
        vergleiche(alt, neu, "termin", z.get("termin").toString(), termin.toString());
        vergleiche(alt, neu, "erwartete_wirkung_wortlaut", z.get("erwartete_wirkung_wortlaut"), wortlaut);
        vergleiche(alt, neu, "erwartete_wirkung_prozent", altProzent == null ? null : altProzent.toPlainString(),
                prozent == null ? null : prozent.toPlainString());
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        BigDecimal p = prozent;
        schreiben(() -> transaktion.execute(s -> {
            jdbc.update("UPDATE massnahme SET titel = ?, termin = ?, erwartete_wirkung_wortlaut = ?, "
                    + "erwartete_wirkung_prozent = ? WHERE id = ?", titel, Date.valueOf(termin), wortlaut, p, id);
            protokoll(tenant, id, "massnahme_geaendert", alt, neu, begruendung, null, wer);
            return id;
        }));
        return eine(id);
    }

    /** RE3/W4: ein aktiver Benutzer des Kundenbereichs; sein Name als Schnappschuss; mit Begründung. */
    public MassnahmeDto.Massnahme verantwortlicher(UUID id, MassnahmeDto.Verantwortlicher v, ProtokollAkteur wer) {
        Map<String, Object> z = geplant(schreibbar(id, wer));
        if (v == null || v.benutzer() == null || v.benutzer().isBlank()) {
            throw VerbesserungAbgelehnt.anfrage("benutzer");
        }
        String begruendung = begruendung(v.begruendung());
        Map<String, Object> b = verantwortlich(v.benutzer());
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        schreiben(() -> transaktion.execute(s -> {
            jdbc.update("UPDATE massnahme SET verantwortlich_sub = ?, verantwortlich_name = ?, verantwortlich_konto = ? "
                    + "WHERE id = ?", b.get("sub"), b.get("name"), b.get("konto"), id);
            protokoll(tenant, id, "verantwortlicher_geaendert", Map.of("verantwortlich_name",
                    z.get("verantwortlich_name")), Map.of("verantwortlich_name", b.get("name")), begruendung, null, wer);
            return id;
        }));
        return eine(id);
    }

    // ================================================================================ umgesetzt, verwerfen (M6)

    /** M6: geplant → umgesetzt, einmalig; der Tag nie in der Zukunft (Zeitzone des Unternehmens), mit Begründung. */
    public MassnahmeDto.Massnahme umgesetzt(UUID id, MassnahmeDto.Umgesetzt u, ProtokollAkteur wer) {
        geplant(schreibbar(id, wer));
        if (u == null || u.am() == null) {
            throw VerbesserungAbgelehnt.anfrage("am");
        }
        String begruendung = begruendung(u.begruendung());
        Instant jetzt = kennzahlen.jetzt();
        LocalDate heute = LocalDate.ofInstant(jetzt, zone());
        if (u.am().isAfter(heute)) {
            throw VerbesserungAbgelehnt.fachlich("umgesetzt_in_der_zukunft", "Umgesetzt ist eine Maßnahme an einem "
                    + "Tag, der schon war.", Map.of("am", u.am().toString(), "heute", heute.toString()));
        }
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        schreiben(() -> transaktion.execute(s -> {
            jdbc.update("UPDATE massnahme SET zustand = 'umgesetzt', umgesetzt_am = ?, umgesetzt_begruendung = ?, "
                    + "umgesetzt_gemeldet_am = ? WHERE id = ?", Date.valueOf(u.am()), begruendung, Timestamp.from(jetzt),
                    id);
            protokoll(tenant, id, "massnahme_umgesetzt", Map.of("zustand", GEPLANT),
                    Map.of("zustand", "umgesetzt", "umgesetzt_am", u.am().toString()), begruendung, null, wer);
            return id;
        }));
        return eine(id);
    }

    /** M6: geplant → verworfen, endgültig, mit Begründung; die Maßnahme wird nie gelöscht. */
    public MassnahmeDto.Massnahme verwerfen(UUID id, MassnahmeDto.Verwerfen v, ProtokollAkteur wer) {
        geplant(schreibbar(id, wer));
        String begruendung = begruendung(v == null ? null : v.begruendung());
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        schreiben(() -> transaktion.execute(s -> {
            jdbc.update("UPDATE massnahme SET zustand = 'verworfen', verworfen_am = ?, verworfen_grund = ? WHERE id = ?",
                    Timestamp.from(kennzahlen.jetzt()), begruendung, id);
            protokoll(tenant, id, "massnahme_verworfen", Map.of("zustand", GEPLANT), Map.of("zustand", "verworfen"),
                    begruendung, null, wer);
            return id;
        }));
        return eine(id);
    }

    // ================================================================================ Einträge (M7)

    /** M7/§5.7: ein Kommentar (1–2 000 Zeichen) an einer geplanten oder umgesetzten Maßnahme — eine Protokollzeile. */
    public MassnahmeDto.Massnahme eintrag(UUID id, MassnahmeDto.NeuerEintrag e, ProtokollAkteur wer) {
        Map<String, Object> z = schreibbar(id, wer);
        if (e == null || (e.art() != null && !e.art().equals("kommentar"))) {
            throw VerbesserungAbgelehnt.anfrage("art");
        }
        String text = e.text() == null ? "" : e.text().strip();
        if (text.isEmpty() || text.length() > 2000) {
            throw VerbesserungAbgelehnt.fachlich("text_ungueltig", "Ein Kommentar hat 1 bis 2 000 Zeichen.",
                    Map.of("min", 1, "max", 2000));
        }
        String zustand = (String) z.get("zustand");
        if (!GEPLANT.equals(zustand) && !"umgesetzt".equals(zustand)) {
            throw nichtOffen(z);
        }
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        transaktion.executeWithoutResult(s -> protokoll(tenant, id, "kommentar", null, null, null, text, wer));
        return eine(id);
    }

    // ================================================================================ Messgrundlage und Ausgangslage

    /** Kennzahl × Fassung × Ausgangslage — die Kopie und ihre Prüfsumme, dazu der Standort der Kennzahl. */
    record Messgrundlage(UUID kennzahl, String kennzahlKennzeichen, UUID basis, String basisKennzeichen, int fassung,
            UUID standort, String text, String pruefsumme) {}

    /**
     * M2: die freigegebene, heute geltende Fassung der Kennzahl (sonst 422 {@code kennzahl_ohne_bezugsbasis}) und
     * die Ausgangslage als Kopie des Vergleich-Lesers über die gewählten, abgeschlossenen Monate.
     */
    Messgrundlage messgrundlage(UUID kennzahl, String monate, ProtokollAkteur wer) {
        KennzahlService.BasisKennzahl k = kennzahlen.fuerBezugsbasis(kennzahl, VERWALTEN, wer, null);
        if (k.zeile().archiviertAm() != null) {
            throw new VerbesserungAbgelehnt(409, "kennzahl_archiviert", "Eine archivierte Kennzahl ist keine "
                    + "Messgrundlage.", Map.of("kennzahl", k.zeile().kennzeichen()));
        }
        LocalDate heute = LocalDate.ofInstant(k.jetzt(), k.zone());
        Map<String, Object> fassung = jdbc.queryForList("SELECT b.id, b.kennzeichen, f.fassung "
                + "FROM bezugsbasis b JOIN bezugsbasis_fassung f ON f.bezugsbasis_id = b.id AND f.tenant_id = b.tenant_id "
                + "WHERE b.kennzahl_id = ? AND b.beendet_am IS NULL AND f.freigabe_status = 'freigegeben' "
                + "AND f.gilt_ab <= ? AND (f.gilt_bis IS NULL OR f.gilt_bis >= ?) ORDER BY f.fassung DESC LIMIT 1",
                kennzahl, Date.valueOf(heute), Date.valueOf(heute)).stream().findFirst().orElseThrow(() ->
                        VerbesserungAbgelehnt.fachlich("kennzahl_ohne_bezugsbasis", "Eine Messgrundlage braucht eine "
                                + "Kennzahl mit freigegebener Bezugsbasis — gegen sie wird die Wirkung gemessen.",
                                Map.of("kennzahl", k.zeile().kennzeichen())));
        YearMonth[] spanne = monate(monate, YearMonth.from(heute));
        String basisKennzeichen = (String) fassung.get("kennzeichen");
        int nummer = ((Number) fassung.get("fassung")).intValue();
        BezugsbasisVergleich.ZielVergleich zv = vergleich.fuerZiel(kennzahl, basisKennzeichen, spanne[0], spanne[1]);
        String text = BerichtRegeln.kanonisch(ausgangslage(k.zeile().kennzeichen(), basisKennzeichen, nummer,
                spanne, zv.vergleich()));
        return new Messgrundlage(kennzahl, k.zeile().kennzeichen(), (UUID) fassung.get("id"), basisKennzeichen, nummer,
                kennzahlen.geltungFuerBericht(kennzahl).standort(), text, BerichtRegeln.pruefsumme(text));
    }

    /**
     * Die Kopie (Muster Berichtsstand): Anker und je Monat das Vergleichsergebnis des Lesers, wie es ist — gemessen
     * mit Version, Bedingung, erwartet, Δ, Band, Urteil, Grund, Kennzeichen, gelesene Fassung, Satz —, dazu der
     * Zeitraum (Σ ÷ Σ). Kein Abrufdatum und kein Stand-Satz: eine zweite Bildung ist byte-gleich.
     */
    private JsonNode ausgangslage(String kennzahl, String basis, int fassung, YearMonth[] spanne,
            BezugsbasisVergleichDto.Vergleich v) {
        ObjectNode o = json.createObjectNode();
        o.put("kennzahl", kennzahl);
        o.put("bezugsbasis", basis);
        o.put("fassung", fassung);
        o.put("monate", spanne[0].equals(spanne[1]) ? spanne[0].toString() : spanne[0] + "/" + spanne[1]);
        var monate = o.putArray("vergleich");
        for (BezugsbasisVergleichDto.Monat m : v.monate()) {
            ObjectNode zeile = monate.addObject();
            zeile.put("periode", m.periode());
            zeile.set("bereinigt", json.valueToTree(m.bereinigt()));
            zeile.put("satz", m.satz());
        }
        o.set("zeitraum", json.valueToTree(v.zeitraum()));
        return o;
    }

    /**
     * AP-18 IP-17 (M5, Antwort {@code neu_kopiert}): die Ausgangslage NEU aus dem Leser — dieselbe Kennzahl, Basis,
     * Fassung und dieselben Monate wie die alte Kopie, dieselbe Bildung wie beim Anlegen; nur die gültigen Versionen
     * unterscheiden sie. Gibt den kanonischen Text und seine Prüfsumme.
     */
    String[] ausgangslageNeu(Map<String, Object> z) {
        JsonNode alt;
        try {
            alt = json.readTree((String) z.get("ausgangslage"));
        } catch (com.fasterxml.jackson.core.JsonProcessingException x) {
            throw new IllegalStateException(x);
        }
        String[] teile = alt.path("monate").asText().split("/", -1);
        YearMonth[] spanne = {YearMonth.parse(teile[0]), YearMonth.parse(teile[teile.length - 1])};
        String basis = (String) z.get("bb");
        BezugsbasisVergleich.ZielVergleich zv = vergleich.fuerZiel((UUID) z.get("kennzahl_id"), basis, spanne[0],
                spanne[1]);
        String text = BerichtRegeln.kanonisch(ausgangslage((String) z.get("kz"), basis,
                ((Number) z.get("fassung")).intValue(), spanne, zv.vergleich()));
        return new String[] {text, BerichtRegeln.pruefsumme(text)};
    }

    /** {@code JJJJ-MM} oder {@code JJJJ-MM/JJJJ-MM}, abgeschlossen, höchstens 12 Monate; ohne: der letzte Monat. */
    private static YearMonth[] monate(String text, YearMonth dieser) {
        if (text == null) {
            return new YearMonth[] {dieser.minusMonths(1), dieser.minusMonths(1)};
        }
        String[] teile = text.strip().split("/", -1);
        if (teile.length > 2 || !MONAT.matcher(teile[0]).matches()
                || (teile.length == 2 && !MONAT.matcher(teile[1]).matches())) {
            throw VerbesserungAbgelehnt.anfrage("monate");
        }
        YearMonth von = YearMonth.parse(teile[0]);
        YearMonth bis = teile.length == 2 ? YearMonth.parse(teile[1]) : von;
        if (bis.isBefore(von) || ChronoUnit.MONTHS.between(von, bis) + 1 > AUSGANGSLAGE_HOECHSTENS_MONATE) {
            throw VerbesserungAbgelehnt.anfrage("monate");
        }
        if (!bis.isBefore(dieser)) {
            throw VerbesserungAbgelehnt.fachlich("monate_nicht_abgeschlossen", "Die Ausgangslage zitiert "
                    + "abgeschlossene Monate.", Map.of("feld", "monate", "spaetestens", dieser.minusMonths(1).toString()));
        }
        return new YearMonth[] {von, bis};
    }

    /** M4: eine Zahl ohne Messgrundlage — mit dem Hinweis, welche Kennzahl fehlt. */
    private VerbesserungAbgelehnt ohneMessgrundlage(Map<String, Object> einsatz) {
        String[] h = hinweis(einsatz);
        return VerbesserungAbgelehnt.fachlich("ohne_messgrundlage", "Ohne Messgrundlage ist die Wirkung nicht messbar: "
                + "die erwartete Wirkung steht dann nur in Worten. Um sie zu messen, braucht " + h[0]
                + " eine Energieleistungskennzahl (" + h[1] + ").", Map.of("feld", "erwartete_wirkung_prozent",
                        "kennzeichen", OHNE_KENNZEICHEN, "hinweis", h[1]));
    }

    /** Wofür die Kennzahl fehlt und welche: aus Träger und erster Einflussgröße des Einsatzes, sonst allgemein. */
    private String[] hinweis(Map<String, Object> einsatz) {
        if (einsatz == null) {
            return new String[] {"diese Maßnahme", "mit einer freigegebenen Bezugsbasis"};
        }
        String einfluss = jdbc.queryForList("SELECT coalesce(bg.name, e.wortlaut) AS name "
                + "FROM energieeinsatz_einflussgroesse e LEFT JOIN bezugsgroesse bg ON bg.id = e.bezugsgroesse_id "
                + "AND bg.tenant_id = e.tenant_id WHERE e.einsatz_id = ? AND e.aufgehoben_am IS NULL "
                + "ORDER BY e.position LIMIT 1", String.class, einsatz.get("id")).stream().filter(Objects::nonNull)
                .findFirst().orElse("Einflussgröße");
        return new String[] {(String) einsatz.get("name"), "zum Beispiel " + einsatz.get("traeger") + " je " + einfluss
                + " mit einer Bezugsbasis"};
    }

    // ================================================================================ Prüfungen

    /** Sichtbar über RLS ({@code site_scope}) und über die Kennzahl (404). */
    private Map<String, Object> sichtbar(UUID id) {
        Map<String, Object> z = jdbc.queryForList(SPALTEN + "WHERE m.id = ?", id).stream().findFirst()
                .orElseThrow(MassnahmeService::nichtGefunden);
        UUID kz = (UUID) z.get("kennzahl_id");
        if (kz != null && kennzahlen.lesbareKennzahlOderNichts(kz) == null) {
            throw nichtGefunden();
        }
        return z;
    }

    /** Sichtbar (404) und das Recht {@code verbesserung.verwalten} an Kennzahl bzw. Standort (403). */
    private Map<String, Object> schreibbar(UUID id, ProtokollAkteur wer) {
        return zeile(id, VERWALTEN, wer);
    }

    /**
     * Die Zeile der Maßnahme: sichtbar (404) und — mit {@code recht} — das Recht an der Geltung der Kennzahl bzw. am
     * Standort der Maßnahme (403). Auch für die Bewertung ({@link MassnahmeBewertung}, {@code verbesserung.abschliessen}).
     */
    Map<String, Object> zeile(UUID id, String recht, ProtokollAkteur wer) {
        Map<String, Object> z = sichtbar(id);
        if (recht == null) {
            return z;
        }
        UUID kz = (UUID) z.get("kennzahl_id");
        if (kz != null) {
            kennzahlen.fuerBezugsbasis(kz, recht, wer, null);
        } else {
            darfAm((UUID) z.get("standort_id"), wer, recht);
        }
        return z;
    }

    private static Map<String, Object> geplant(Map<String, Object> z) {
        if (!GEPLANT.equals(z.get("zustand"))) {
            throw nichtOffen(z);
        }
        return z;
    }

    private static VerbesserungAbgelehnt nichtOffen(Map<String, Object> z) {
        return new VerbesserungAbgelehnt(409, "massnahme_nicht_geplant", "Die Maßnahme " + z.get("kennzeichen")
                + " ist " + z.get("zustand") + "; das geht nur, solange sie geplant ist.",
                Map.of("zustand", z.get("zustand")));
    }

    static VerbesserungAbgelehnt nichtGefunden() {
        return new VerbesserungAbgelehnt(404, "nicht_gefunden", "Diese Maßnahme gibt es nicht.", null);
    }

    /**
     * RE1/RE2: das Recht ({@code verbesserung.verwalten}, beim Bewerten {@code verbesserung.abschliessen}) am Standort
     * bzw. am Unternehmen ({@code null}).
     */
    private void darfAm(UUID standort, ProtokollAkteur wer, String recht) {
        if (standort != null && jdbc.queryForList("SELECT 1 FROM standort WHERE id = ?", standort).isEmpty()) {
            // RLS: ein Standort außerhalb der eigenen Sicht ist derselbe wie einer, den es nicht gibt (Zaun, 404).
            throw new VerbesserungAbgelehnt(404, "standort_unbekannt", "Diesen Standort gibt es in Ihrem "
                    + "Kundenbereich nicht.", Map.of("feld", "standort"));
        }
        ZoneId zone = zone();
        kennzahlen.darf(wer, new KennzahlService.Geltung(standort == null ? "unternehmen" : "standort", standort, null,
                null, standort, null, recht, zone), kennzahlen.jetzt());
    }

    /** Ein sichtbarer Energieeinsatz des Kundenbereichs, sonst 422 {@code einsatz_unbekannt}. */
    private Map<String, Object> einsatz(UUID id) {
        return jdbc.queryForList("SELECT id, kennzeichen, name, traeger FROM energieeinsatz WHERE id = ?", id).stream()
                .findFirst().orElseThrow(() -> VerbesserungAbgelehnt.fachlich("einsatz_unbekannt", "Diesen "
                        + "Energieeinsatz gibt es in Ihrem Kundenbereich nicht.", Map.of("feld", "einsatz")));
    }

    /** Ein sichtbares Energieziel (RLS und seine Kennzahl), sonst 422 {@code energieziel_unbekannt}. */
    private Map<String, Object> energieziel(UUID id) {
        Map<String, Object> z = jdbc.queryForList("SELECT id, kennzeichen, kennzahl_id FROM energieziel WHERE id = ?", id)
                .stream().findFirst().orElse(null);
        if (z == null || kennzahlen.lesbareKennzahlOderNichts((UUID) z.get("kennzahl_id")) == null) {
            throw VerbesserungAbgelehnt.fachlich("energieziel_unbekannt", "Dieses Energieziel gibt es in Ihrem "
                    + "Kundenbereich nicht.", Map.of("feld", "energieziel"));
        }
        return z;
    }

    /**
     * W14, FS3: die Herkünfte aus dem Energiemanagement nennen ein sichtbares Objekt (RLS und Standort-Zaun) im richtigen
     * Zustand, sonst 422 — die Feststellung offen (gesperrt bis zum Ende des Anlegens, damit kein schließender Stand
     * dazwischenkommt), das interne Audit durchgeführt oder abgeschlossen, der Beschluss n einer freigegebenen
     * Managementbewertung. Die Managementbewertung hat noch keine Tabelle (AP-19 IP-23): bis dahin ist jede BR-Kennung
     * unbekannt. Die Abweichung prüft weiter nur ihr Muster — das ist AP-18-Sache (W14).
     */
    private void herkunftPruefen(String herkunft, String kennung) {
        switch (herkunft) {
            case "nichtkonformitaet" -> {
                String zustand = zustand("SELECT zustand FROM feststellung WHERE kennzeichen = ? FOR SHARE", kennung);
                if (!"offen".equals(zustand)) {
                    throw VerbesserungAbgelehnt.fachlich("feststellung_nicht_offen", "Die Feststellung " + kennung
                            + " ist abgeschlossen — eine Maßnahme entsteht nur an einer offenen Feststellung.",
                            Map.of("feld", "herkunft_kennung", "zustand", zustand));
                }
            }
            case "audit" -> {
                String zustand = zustand("SELECT zustand FROM internes_audit WHERE kennzeichen = ?", kennung);
                if (!"durchgefuehrt".equals(zustand) && !"abgeschlossen".equals(zustand)) {
                    throw VerbesserungAbgelehnt.fachlich("audit_nicht_durchgefuehrt", "Das interne Audit " + kennung
                            + ("abgesagt".equals(zustand) ? " ist abgesagt" : " ist noch nicht durchgeführt")
                            + " — eine Maßnahme entsteht nur aus einem durchgeführten Audit.",
                            Map.of("feld", "herkunft_kennung", "zustand", zustand));
                }
            }
            case "managementbewertung" -> throw herkunftUnbekannt(kennung);
            default -> {
            }
        }
    }

    /** Der Zustand des sichtbaren Objekts mit dieser Kennung, sonst 422 {@code herkunft_kennung}. */
    private String zustand(String sql, String kennung) {
        return jdbc.queryForList(sql, String.class, kennung).stream().findFirst()
                .orElseThrow(() -> herkunftUnbekannt(kennung));
    }

    private static VerbesserungAbgelehnt herkunftUnbekannt(String kennung) {
        return VerbesserungAbgelehnt.fachlich("herkunft_kennung", kennung + " gibt es in Ihrem Kundenbereich nicht.",
                Map.of("feld", "herkunft_kennung"));
    }

    private static Map<String, Object> verweisPflicht(Map<String, Object> verweis, String feld) {
        if (verweis == null) {
            throw VerbesserungAbgelehnt.fachlich("herkunft_ohne_verweis", "Eine Maßnahme aus einem " + ("einsatz"
                    .equals(feld) ? "Energieeinsatz" : "Energieziel") + " nennt ihn.", Map.of("feld", feld));
        }
        return verweis;
    }

    /** Die Trigger von IP-9 als Ablehnung mit Code; alles andere bleibt ein Fehler. */
    private <T> T schreiben(java.util.function.Supplier<T> weg) {
        try {
            return weg.get();
        } catch (DataIntegrityViolationException x) {
            String grund = String.valueOf(x.getMostSpecificCause().getMessage());
            for (String[] c : new String[][] {
                {"massnahme_fassung_freigegeben_chk", "fassung_nicht_freigegeben"},
                {"massnahme_einstufung_freigegeben_chk", "einstufung_nicht_freigegeben"},
                {"massnahme_einstufung_fk", "einstufung_unbekannt"},
                {"massnahme_standort_der_kennzahl_chk", "standort_der_kennzahl"},
                {"massnahme_umgesetzt_nicht_in_der_zukunft", "umgesetzt_in_der_zukunft"},
                {"massnahme_uebergang_einmalig", "massnahme_nicht_geplant"},
                {"massnahme_nur_geplant_aenderbar", "massnahme_nicht_geplant"},
                {"massnahme_endgueltig", "massnahme_nicht_geplant"}}) {
                if (grund.contains(c[0])) {
                    int status = c[1].equals("massnahme_nicht_geplant") ? 409 : 422;
                    throw new VerbesserungAbgelehnt(status, c[1], "Die Maßnahme wurde so nicht gespeichert.",
                            Map.of("grund", c[0]));
                }
            }
            throw x;
        }
    }

    private static UUID uuid(String text, String feld) {
        try {
            return UUID.fromString(text);
        } catch (IllegalArgumentException x) {
            throw VerbesserungAbgelehnt.anfrage(feld);
        }
    }

    private static String pflichttext(String text, String code, String satz) {
        if (text == null || text.isBlank()) {
            throw VerbesserungAbgelehnt.fachlich(code, satz, null);
        }
        return text.strip();
    }

    /** M4: Prozent gegenüber dem Erwarteten, eine Stelle, zwischen −100 und 100 (weniger Energie negativ). */
    private static BigDecimal prozent(BigDecimal wert) {
        if (wert == null) {
            return null;
        }
        if (wert.stripTrailingZeros().scale() > 1 || wert.abs().compareTo(BigDecimal.valueOf(100)) >= 0) {
            throw VerbesserungAbgelehnt.anfrage("erwartete_wirkung_prozent");
        }
        return wert.setScale(1, RoundingMode.UNNECESSARY);
    }

    /** Begründung 10–500 Zeichen (Muster Bezugsbasis-Anstoß, §5.7). */
    private static String begruendung(String text) {
        String b = text == null ? "" : text.strip();
        if (b.length() < 10 || b.length() > 500) {
            throw VerbesserungAbgelehnt.fachlich("begruendung_fehlt", "Bitte begründen Sie mit 10 bis 500 Zeichen.",
                    Map.of("min", 10, "max", 500));
        }
        return b;
    }

    /** RE3: ein aktives Konto des Kundenbereichs (Fremdschlüssel + Schnappschuss) — sonst 422. */
    private Map<String, Object> verantwortlich(String sub) {
        if (sub == null || sub.isBlank()) {
            throw VerbesserungAbgelehnt.fachlich("verantwortlich_fehlt", "Bitte nennen Sie eine verantwortliche Person "
                    + "aus Ihrem Kundenbereich.", null);
        }
        return jdbc.queryForList("SELECT sub, konto, anzeigename FROM benutzer WHERE sub = ? AND zustand = 'aktiv'",
                sub.strip()).stream().findFirst().map(b -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("sub", b.get("sub"));
                    m.put("konto", b.get("konto"));
                    String name = (String) b.get("anzeigename");
                    m.put("name", name == null || name.isBlank() ? b.get("sub") : name);
                    return m;
                }).orElseThrow(() -> VerbesserungAbgelehnt.fachlich("benutzer_unbekannt",
                        "Diese Person gibt es in Ihrem Kundenbereich nicht.", Map.of("benutzer", sub)));
    }

    private static void vergleiche(Map<String, Object> alt, Map<String, Object> neu, String feld, Object a, Object n) {
        if (!Objects.equals(a, n)) {
            alt.put(feld, a);
            neu.put(feld, n);
        }
    }

    // ================================================================================ Protokoll und Darstellung

    void protokoll(UUID tenant, UUID id, String art, Map<String, Object> alt, Map<String, Object> neu,
            String begruendung, String kommentar, ProtokollAkteur wer) {
        jdbc.update("INSERT INTO massnahme_aenderung (tenant_id, massnahme_id, art, alt, neu, begruendung, kommentar, "
                + "actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?, ?)",
                tenant, id, art, text(alt), text(neu), begruendung, kommentar, wer.sub(), wer.name(), wer.rolle(),
                wer.art());
    }

    private List<MassnahmeDto.Eintrag> verlauf(UUID id) {
        return jdbc.query("SELECT id, art, alt::text AS alt, neu::text AS neu, begruendung, kommentar, actor_name, "
                + "created_at FROM massnahme_aenderung WHERE massnahme_id = ? ORDER BY created_at, id", (rs, i) ->
                        new MassnahmeDto.Eintrag(rs.getLong("id"), rs.getString("art"), map(rs.getString("alt")),
                                map(rs.getString("neu")), rs.getString("begruendung"), rs.getString("kommentar"),
                                rs.getString("actor_name"), rs.getTimestamp("created_at").toInstant()), id);
    }

    private String text(Map<String, Object> m) {
        try {
            return m == null ? null : json.writeValueAsString(m);
        } catch (com.fasterxml.jackson.core.JsonProcessingException x) {
            throw new IllegalStateException(x);
        }
    }

    private Map<String, Object> map(String text) {
        try {
            return text == null ? null : json.readValue(text, new TypeReference<LinkedHashMap<String, Object>>() {});
        } catch (com.fasterxml.jackson.core.JsonProcessingException x) {
            throw new IllegalStateException(x);
        }
    }

    /** Die Zeitzone des Unternehmens (Tag des Anlegens, „heute“, Termin, Tag eines Bewertungs-Stands). */
    ZoneId zone() {
        return ZoneId.of(jdbc.queryForList("SELECT zeitzone FROM unternehmen LIMIT 1", String.class).stream()
                .filter(Objects::nonNull).findFirst().orElse("Europe/Berlin"));
    }

    private MassnahmeDto.Massnahme dto(Map<String, Object> z, ZoneId zone, LocalDate abruf,
            List<MassnahmeDto.Eintrag> verlauf) {
        String kennzeichen = (String) z.get("kennzeichen");
        String titel = (String) z.get("titel");
        String zustand = (String) z.get("zustand");
        String person = (String) z.get("verantwortlich_name");
        LocalDate termin = ((Date) z.get("termin")).toLocalDate();
        LocalDate angelegt = LocalDate.ofInstant(((Timestamp) z.get("angelegt_am")).toInstant(), zone);
        LocalDate umgesetzt = z.get("umgesetzt_am") == null ? null : ((Date) z.get("umgesetzt_am")).toLocalDate();
        BigDecimal prozent = (BigDecimal) z.get("erwartete_wirkung_prozent");
        String wortlaut = (String) z.get("erwartete_wirkung_wortlaut");
        UUID einsatzId = (UUID) z.get("einsatz_id");
        MassnahmeDto.Verweis einsatz = einsatzId == null ? null
                : new MassnahmeDto.Verweis(einsatzId, (String) z.get("ee"), (String) z.get("ee_name"));
        UUID zielId = (UUID) z.get("energieziel_id");
        MassnahmeDto.Verweis ziel = zielId == null ? null
                : new MassnahmeDto.Verweis(zielId, (String) z.get("ez"), (String) z.get("ez_wortlaut"));

        MassnahmeDto.Messgrundlage mg = null;
        MassnahmeDto.OhneMessgrundlage ohne = null;
        if (z.get("kennzahl_id") != null) {
            String text = (String) z.get("ausgangslage");
            Map<String, Object> inhalt = map(text);
            String methode = (String) z.get("methode");
            mg = new MassnahmeDto.Messgrundlage(
                    new MassnahmeDto.Verweis((UUID) z.get("kennzahl_id"), (String) z.get("kz"), (String) z.get("kz_name")),
                    new MassnahmeDto.Verweis((UUID) z.get("bezugsbasis_id"), (String) z.get("bb"), null),
                    ((Number) z.get("fassung")).intValue(), METHODEN.getOrDefault(methode, methode), text,
                    (String) z.get("ausgangslage_pruefsumme"), inhalt,
                    messgrundlageSatz(z, inhalt, methode, angelegt, prozent, wortlaut));
        } else {
            Map<String, Object> e = einsatzId == null ? null : Map.of("id", einsatzId, "name", z.get("ee_name"),
                    "traeger", z.get("ee_traeger"));
            String[] h = hinweis(e);
            ohne = new MassnahmeDto.OhneMessgrundlage(OHNE_KENNZEICHEN, h[1], satz("ohne_messgrundlage",
                    Map.of("kennzeichen", kennzeichen, "titel", titel, "einsatz", h[0], "hinweis", h[1])));
        }

        Map<String, Object> f = VerbesserungRegeln.frist(new VerbesserungRegeln.FristEingang("massnahme", zustand,
                termin.toString(), null, null, abruf.toString()));
        String faellig = (String) f.get("faellig");
        Integer seit = (Integer) f.get("seit_tagen");
        String fristSatz = faellig == null ? null : satz("ueberfaellig", Map.of("kennzeichen", kennzeichen,
                "zustand", zustand, "termin", TAG.format(termin), "tage", String.valueOf(seit), "person", person));
        String kopf = umgesetzt == null ? null : satz("massnahme_kopf", Map.of("kennzeichen", kennzeichen,
                "titel", titel, "person", person, "termin", TAG.format(termin), "umgesetzt_am", TAG.format(umgesetzt)));
        Timestamp verworfen = (Timestamp) z.get("verworfen_am");
        MassnahmeDto.Bewertung[] staende = staende((UUID) z.get("id"), zone);
        return new MassnahmeDto.Massnahme((UUID) z.get("id"), kennzeichen, titel,
                new MassnahmeDto.Person((String) z.get("verantwortlich_sub"), person), termin,
                (UUID) z.get("standort_id"), zustand,
                new MassnahmeDto.Herkunft((String) z.get("herkunft_art"), (String) z.get("herkunft_kennung")), mg, ohne,
                einsatz, (Integer) z.get("einstufung_fassung"), ziel, prozent == null ? null : prozent.toPlainString(),
                wortlaut, angelegt, umgesetzt, (String) z.get("umgesetzt_begruendung"),
                verworfen == null ? null : verworfen.toInstant(), (String) z.get("verworfen_grund"),
                new MassnahmeDto.Frist(abruf, termin, faellig, seit, fristSatz), kopf, staende[0], staende[1],
                verlauf == null ? null : anstoesse((UUID) z.get("id")), verlauf);
    }

    /** Die Anstöße an der Maßnahme (M5, IP-17), älteste zuerst — offene und beantwortete. */
    private List<MassnahmeDto.Anstoss> anstoesse(UUID id) {
        return jdbc.query("SELECT id, art, anlass_kennung, angestossen_am, zustand, antwort, antwort_begruendung, "
                + "beantwortet_am, beantwortet_name FROM vorgang_anstoss WHERE massnahme_id = ? "
                + "ORDER BY angestossen_am, anlass_kennung", (rs, i) -> {
                    Timestamp am = rs.getTimestamp("beantwortet_am");
                    return new MassnahmeDto.Anstoss(rs.getObject("id", UUID.class), rs.getString("art"),
                            rs.getString("anlass_kennung"), rs.getTimestamp("angestossen_am").toInstant(),
                            rs.getString("zustand"), rs.getString("antwort"), rs.getString("antwort_begruendung"),
                            am == null ? null : am.toInstant(), rs.getString("beantwortet_name"));
                }, id);
    }

    // ================================================================================ Stände (WK6, IP-12)

    /** Die Spalten eines Bewertungs-Stands ({@code massnahme_bewertung}) für {@link #stand}. */
    static final String STAND_SPALTEN = "SELECT stand_nr, status, ergebnis, begruendung, vieraugen, wirkung, pruefsumme, "
            + "freigabe_sub, freigabe_name, freigabe_am, entscheidung_sub, entscheidung_name, entschieden_am, "
            + "entscheidungs_begruendung FROM massnahme_bewertung ";

    /** Der jüngste bewertete Stand und der offene Antrag (Vier-Augen) — je {@code null}, wenn es keinen gibt. */
    private MassnahmeDto.Bewertung[] staende(UUID id, ZoneId zone) {
        MassnahmeDto.Bewertung[] aus = new MassnahmeDto.Bewertung[2];
        for (Map<String, Object> r : jdbc.queryForList(STAND_SPALTEN + "WHERE massnahme_id = ? AND status IN "
                + "('bewertet', 'beantragt') ORDER BY stand_nr DESC", id)) {
            int i = "bewertet".equals(r.get("status")) ? 0 : 1;
            if (aus[i] == null) {
                aus[i] = stand(r, zone);
            }
        }
        return aus;
    }

    /**
     * Ein Stand Nr. n mit dem Kundensatz aus §5.9: {@code bewertung_belegt} (die Zahl mit Bedingung aus der Kopie) bzw.
     * {@code bewertung_nicht_messbar} — nur an einem bewerteten Stand; für {@code nicht_belegt} hat §5.9 keinen Satz.
     */
    MassnahmeDto.Bewertung stand(Map<String, Object> r, ZoneId zone) {
        String status = (String) r.get("status");
        String ergebnis = (String) r.get("ergebnis");
        String begruendung = (String) r.get("begruendung");
        String kopie = (String) r.get("wirkung");
        String pruefsumme = (String) r.get("pruefsumme");
        Instant am = ((Timestamp) r.get("freigabe_am")).toInstant();
        String person = (String) r.get("freigabe_name");
        int nr = ((Number) r.get("stand_nr")).intValue();
        String satz = null;
        if ("bewertet".equals(status) && "nicht_messbar".equals(ergebnis)) {
            satz = satz("bewertung_nicht_messbar", Map.of("am", TAG.format(LocalDate.ofInstant(am, zone)),
                    "person", person, "begruendung", begruendung));
        } else if ("bewertet".equals(status) && "belegt".equals(ergebnis) && kopie != null) {
            satz = belegtSatz(map(kopie), nr, person, LocalDate.ofInstant(am, zone), begruendung, pruefsumme);
        }
        Timestamp entschieden = (Timestamp) r.get("entschieden_am");
        String entscheider = (String) r.get("entscheidung_name");
        return new MassnahmeDto.Bewertung(nr, status, ergebnis, begruendung, (Boolean) r.get("vieraugen"),
                new MassnahmeDto.Person((String) r.get("freigabe_sub"), person), am,
                entscheider == null ? null : new MassnahmeDto.Person((String) r.get("entscheidung_sub"), entscheider),
                entschieden == null ? null : entschieden.toInstant(), (String) r.get("entscheidungs_begruendung"),
                kopie, pruefsumme, satz);
    }

    /** „Belegt von … am …: ‚…‘ Beobachtet: 2,4 % weniger (8 von 12 Monaten). Stand Nr. 1, Prüfsumme 4635…“ */
    @SuppressWarnings("unchecked")
    private static String belegtSatz(Map<String, Object> kopie, int nr, String person, LocalDate am, String begruendung,
            String pruefsumme) {
        Map<String, Object> w = (Map<String, Object>) kopie.get("wirkung");
        Object delta = w == null ? null : w.get("delta_prozent");
        String nachher = (String) kopie.get("nachher");
        if (delta == null || nachher == null || w.get("monate_bewertbar") == null) {
            return null;
        }
        String d = new BigDecimal(delta.toString()).toPlainString();
        long soll = ChronoUnit.MONTHS.between(YearMonth.parse(nachher.substring(0, 7)),
                YearMonth.parse(nachher.substring(8))) + 1;
        Map<String, String> werte = new LinkedHashMap<>();
        werte.put("person", person);
        werte.put("am", TAG.format(am));
        werte.put("begruendung", begruendung);
        werte.put("prozent", EnergiezielService.prozent(d, d.startsWith("-") ? "weniger" : "mehr"));
        werte.put("monate", w.get("monate_bewertbar") + " von " + soll);
        werte.put("stand", String.valueOf(nr));
        werte.put("pruefsumme", pruefsumme.substring("sha256:".length(), "sha256:".length() + 4) + "…");
        return satz("bewertung_belegt", werte);
    }

    /**
     * §5.9 „Messgrundlage“: nur für eine Ausgangslage aus EINEM Monat mit Urteil und eine Zahl der erwarteten Wirkung —
     * sonst fehlt dem Satz ein Teil, und er bleibt leer (die Felder stehen daneben).
     */
    @SuppressWarnings("unchecked")
    private static String messgrundlageSatz(Map<String, Object> z, Map<String, Object> inhalt, String methode,
            LocalDate angelegt, BigDecimal prozent, String wortlaut) {
        List<Map<String, Object>> monate = (List<Map<String, Object>>) inhalt.get("vergleich");
        if (prozent == null || monate == null || monate.size() != 1) {
            return null;
        }
        Map<String, Object> m = monate.get(0);
        Map<String, Object> b = (Map<String, Object>) m.get("bereinigt");
        List<Map<String, Object>> bedingung = (List<Map<String, Object>>) b.get("bedingung");
        Map<String, Object> gemessen = (Map<String, Object>) b.get("gemessen");
        if (b.get("delta_prozent") == null || bedingung == null || bedingung.isEmpty() || gemessen == null
                || gemessen.get("version") == null) {
            return null;
        }
        Map<String, String> werte = new LinkedHashMap<>();
        werte.put("kennzahl", z.get("kz") + " " + z.get("kz_name"));
        werte.put("bezugsbasis", (String) z.get("bb"));
        werte.put("fassung", String.valueOf(z.get("fassung")));
        werte.put("bereinigt_um", String.valueOf(bedingung.get(0).get("name")));
        werte.put("methode", METHODEN.getOrDefault(methode, methode));
        werte.put("ausgangslage_monat", KennzahlRegeln.periodeText("monat", (String) m.get("periode")));
        werte.put("ausgangslage_prozent", EnergiezielService.prozent(String.valueOf(b.get("delta_prozent")),
                (String) b.get("richtung")));
        werte.put("version", String.valueOf(gemessen.get("version")));
        werte.put("kopiert_am", TAG.format(angelegt));
        werte.put("erwartete_wirkung", EnergiezielService.zielwertText(prozent));
        werte.put("wortlaut", wortlaut);
        return satz("messgrundlage", werte);
    }

    private static String satz(String schluessel, Map<String, String> werte) {
        Object s = VerbesserungRegeln.satz(schluessel, werte).get("satz");
        return s == null ? null : s.toString();
    }
}
