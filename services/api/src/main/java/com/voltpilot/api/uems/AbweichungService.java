package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.AbweichungDto;
import com.voltpilot.api.web.dto.BezugsbasisVergleichDto;
import java.sql.Date;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
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
 * Auffälligkeit und Abweichung (UEMS AP-18 IP-16, A2–A6, U1–U3, RE1–RE3): die Vermerke einer Kennzahl lesen und
 * beantworten, Abweichungen eröffnen (aus Vermerken oder von Hand), lesen, Einträge, Frist, Verantwortlicher, Abschluss —
 * jede Änderung eine Zeile im Protokoll {@code abweichung_aenderung}. Tabellen und Trigger bringt IP-14; die Vermerke
 * schreibt die Naht (IP-15). Gerechnet wird hier nichts, und keine Antwort ändert eine Zahl (A5).
 *
 * <p><b>A2 Antwort:</b> {@code abweichung} eröffnet AW-JJJJ-nnnn (Jahr des Eröffnens) mit ALLEN offenen Vermerken
 * derselben Kennzahl × Bezugsbasis-Fassung — eine Abweichung zitiert genau eine Fassung (A3), Vermerke einer anderen
 * Fassung bleiben offen. Anlass = die Kopie des Vermerks, byte-gleich (bei mehreren {@code {"vermerke": […]}}
 * kanonisch), Prüfsumme wie {@code bericht_pruefsumme}. {@code zur_kenntnis} nur mit Begründung 10–500.
 *
 * <p><b>A3 von Hand:</b> Anlass = kanonische Kopie des Vergleich-Lesers ({@link BezugsbasisVergleich#fuerZiel}) über
 * die gewählten, abgeschlossenen Monate — alle gegen dieselbe Fassung —, dazu ein Wortlaut, warum (auch an
 * {@code im_rahmen}).
 *
 * <p><b>Uhr:</b> „heute“, „abgeschlossen“ und „Frist ≥ Eröffnungstag“ prüft der Dienst mit der Uhr der Kennzahlen
 * (Zeitzone des Unternehmens) — nie {@code now()} in SQL; die Vorgabe der Frist (+ 30) setzt der Trigger.
 *
 * <p><b>Zaun (RE2):</b> RLS {@code site_scope} über {@code standort_id} und die Kennzahl ({@link
 * KennzahlService#fuerBezugsbasis}) — außerhalb 404; {@code verbesserung.verwalten} bzw. am Abschluss
 * {@code verbesserung.abschliessen} an der Geltung der Kennzahl, sonst 403. Verantwortung verleiht kein Recht (RE3).
 */
@Service
public class AbweichungService {

    static final String VERWALTEN = "verbesserung.verwalten";
    static final String ABSCHLIESSEN = "verbesserung.abschliessen";
    static final Set<String> LISTE_PARAMETER = Set.of("zustand", "ueberfaellig", "kennzahl");
    static final Set<String> VERMERK_PARAMETER = Set.of("zustand");
    /** Eine Abweichung von Hand zitiert höchstens ein Jahr. */
    static final int HOECHSTENS_MONATE = 12;
    private static final String OFFEN = "offen";
    private static final Pattern MONAT = Pattern.compile("\\d{4}-(0[1-9]|1[0-2])");
    private static final DateTimeFormatter TAG = DateTimeFormatter.ofPattern("dd.MM.yyyy");

    private final KennzahlService kennzahlen;
    private final BezugsbasisVergleich vergleich;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaktion;
    private final ObjectMapper json;

    public AbweichungService(KennzahlService kennzahlen, BezugsbasisVergleich vergleich, JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager, ObjectMapper json) {
        this.kennzahlen = kennzahlen;
        this.vergleich = vergleich;
        this.jdbc = jdbc;
        this.transaktion = new TransactionTemplate(transactionManager);
        this.json = json;
    }

    private static final String ABWEICHUNG = "SELECT a.*, k.kennzeichen AS kz, k.name AS kz_name, "
            + "b.kennzeichen AS bb, m.kennzeichen AS mk, m.titel AS m_titel FROM abweichung a "
            + "JOIN kennzahl k ON k.id = a.kennzahl_id AND k.tenant_id = a.tenant_id "
            + "JOIN bezugsbasis b ON b.id = a.bezugsbasis_id AND b.tenant_id = a.tenant_id "
            + "LEFT JOIN massnahme m ON m.id = a.massnahme_id AND m.tenant_id = a.tenant_id ";

    private static final String VERMERK = "SELECT v.*, k.kennzeichen AS kz, k.name AS kz_name, "
            + "b.kennzeichen AS bb, a.kennzeichen AS aw FROM auffaelligkeit v "
            + "JOIN kennzahl k ON k.id = v.kennzahl_id AND k.tenant_id = v.tenant_id "
            + "JOIN bezugsbasis b ON b.id = v.bezugsbasis_id AND b.tenant_id = v.tenant_id "
            + "LEFT JOIN abweichung a ON a.id = v.abweichung_id AND a.tenant_id = v.tenant_id ";

    // ================================================================================ Vermerke (A1, A2)

    /** Die Vermerke der Kennzahl (Zaun über die Kennzahl und {@code standort_id}), Filter {@code zustand}. */
    public AbweichungDto.Vermerke vermerke(UUID kennzahl, Collection<String> parameter, String zustand) {
        parameter.stream().filter(p -> !VERMERK_PARAMETER.contains(p)).findFirst().ifPresent(p -> {
            throw VerbesserungAbgelehnt.anfrage(p);
        });
        if (zustand != null && !VerbesserungRegeln.VOKABULARE.get("auffaelligkeit_zustand").contains(zustand)) {
            throw VerbesserungAbgelehnt.anfrage("zustand");
        }
        KennzahlService.BasisKennzahl k = kennzahlen.fuerBezugsbasis(kennzahl, null, null, null);
        ZoneId zone = zone();
        List<AbweichungDto.Vermerk> aus = new ArrayList<>();
        int offen = 0;
        for (Map<String, Object> z : jdbc.queryForList(VERMERK + "WHERE v.kennzahl_id = ? ORDER BY v.periode, v.fassung",
                kennzahl)) {
            if (OFFEN.equals(z.get("zustand"))) {
                offen++;
            }
            if (zustand == null || zustand.equals(z.get("zustand"))) {
                aus.add(vermerk(z, zone));
            }
        }
        String name = jdbc.queryForObject("SELECT name FROM kennzahl WHERE id = ?", String.class, kennzahl);
        return new AbweichungDto.Vermerke(new AbweichungDto.Verweis(kennzahl, k.zeile().kennzeichen(), name),
                LocalDate.ofInstant(k.jetzt(), zone), offen, List.copyOf(aus));
    }

    /**
     * A2: die einmalige Antwort einer Person. {@code abweichung} eröffnet AW-… mit allen offenen Vermerken derselben
     * Kennzahl × Fassung; {@code zur_kenntnis} braucht eine Begründung (422 {@code begruendung_fehlt}).
     */
    public AbweichungDto.Beantwortet antworten(UUID kennzahl, UUID vermerkId, AbweichungDto.Antwort a,
            ProtokollAkteur wer) {
        KennzahlService.BasisKennzahl k = kennzahlen.fuerBezugsbasis(kennzahl, VERWALTEN, wer, null);
        Map<String, Object> v = jdbc.queryForList(VERMERK + "WHERE v.id = ? AND v.kennzahl_id = ?", vermerkId, kennzahl)
                .stream().findFirst().orElseThrow(AbweichungService::vermerkNichtGefunden);
        if (!OFFEN.equals(v.get("zustand"))) {
            throw beantwortet(v);
        }
        if (a == null || a.antwort() == null
                || !VerbesserungRegeln.VOKABULARE.get("auffaelligkeit_antwort").contains(a.antwort())) {
            throw VerbesserungAbgelehnt.anfrage("antwort");
        }
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        Instant jetzt = k.jetzt();
        ZoneId zone = zone();
        if (a.antwort().equals("zur_kenntnis")) {
            if (a.frist() != null) {
                throw VerbesserungAbgelehnt.anfrage("frist");
            }
            if (a.verantwortlich() != null) {
                throw VerbesserungAbgelehnt.anfrage("verantwortlich");
            }
            String begruendung = begruendung(a.begruendung());
            schreiben(() -> transaktion.execute(s -> {
                int n = jdbc.update("UPDATE auffaelligkeit SET zustand = 'beantwortet', antwort = 'zur_kenntnis', "
                        + "antwort_begruendung = ?, beantwortet_am = ?, beantwortet_sub = ?, beantwortet_name = ?, "
                        + "beantwortet_rolle = ?, beantwortet_art = ? WHERE id = ? AND zustand = 'offen'", begruendung,
                        Timestamp.from(jetzt), wer.sub(), wer.name(), wer.rolle(), wer.art(), vermerkId);
                if (n != 1) {
                    throw beantwortet(v);
                }
                return vermerkId;
            }));
            return new AbweichungDto.Beantwortet(einVermerk(vermerkId, zone), null);
        }

        String begruendung = a.begruendung() == null ? null : begruendung(a.begruendung());
        Map<String, Object> person = verantwortlich(a.verantwortlich());
        LocalDate heute = LocalDate.ofInstant(jetzt, zone);
        fristNichtVor(a.frist(), heute);
        UUID standort = kennzahlen.geltungFuerBericht(kennzahl).standort();
        UUID neu = schreiben(() -> transaktion.execute(s -> {
            // Alle offenen Vermerke derselben Kennzahl × Fassung, gesperrt — eine zweite Antwort wartet und findet
            // sie beantwortet.
            List<Map<String, Object>> offen = jdbc.queryForList("SELECT id, periode, anlass FROM auffaelligkeit "
                    + "WHERE kennzahl_id = ? AND bezugsbasis_id = ? AND fassung = ? AND zustand = 'offen' "
                    + "ORDER BY periode FOR UPDATE", kennzahl, v.get("bezugsbasis_id"), v.get("fassung"));
            if (offen.stream().noneMatch(o -> vermerkId.equals(o.get("id")))) {
                throw beantwortet(v);
            }
            List<String> monate = offen.stream().map(o -> (String) o.get("periode")).toList();
            String anlass;
            if (offen.size() == 1) {
                anlass = (String) offen.get(0).get("anlass");
            } else {
                ObjectNode o = json.createObjectNode();
                var liste = o.putArray("vermerke");
                offen.forEach(x -> liste.add(baum((String) x.get("anlass"))));
                anlass = BerichtRegeln.kanonisch(o);
            }
            Map<String, Object> id = eroeffnen(tenant, kennzahl, (UUID) v.get("bezugsbasis_id"),
                    ((Number) v.get("fassung")).intValue(), monate, "auffaelligkeit", null, anlass, person, a.frist(),
                    standort, jetzt, wer);
            List<UUID> ids = offen.stream().map(o -> (UUID) o.get("id")).toList();
            for (UUID x : ids) {
                jdbc.update("UPDATE auffaelligkeit SET zustand = 'beantwortet', antwort = 'abweichung', "
                        + "antwort_begruendung = ?, abweichung_id = ?, beantwortet_am = ?, beantwortet_sub = ?, "
                        + "beantwortet_name = ?, beantwortet_rolle = ?, beantwortet_art = ? WHERE id = ?", begruendung,
                        id.get("id"), Timestamp.from(jetzt), wer.sub(), wer.name(), wer.rolle(), wer.art(), x);
            }
            return (UUID) id.get("id");
        }));
        return new AbweichungDto.Beantwortet(einVermerk(vermerkId, zone), eine(neu));
    }

    // ================================================================================ Abweichung lesen

    /** Das Register im Zaun; Filter Zustand, überfällig (Operation {@code frist}), Kennzahl. */
    public AbweichungDto.Liste liste(Collection<String> parameter, String zustand, String ueberfaellig,
            String kennzahlText) {
        parameter.stream().filter(p -> !LISTE_PARAMETER.contains(p)).findFirst().ifPresent(p -> {
            throw VerbesserungAbgelehnt.anfrage(p);
        });
        StringBuilder sql = new StringBuilder(ABWEICHUNG).append("WHERE true ");
        List<Object> args = new ArrayList<>();
        if (zustand != null) {
            if (!VerbesserungRegeln.VOKABULARE.get("abweichung_zustand").contains(zustand)) {
                throw VerbesserungAbgelehnt.anfrage("zustand");
            }
            sql.append("AND a.zustand = ? ");
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
            UUID kennzahl;
            try {
                kennzahl = UUID.fromString(kennzahlText);
            } catch (IllegalArgumentException x) {
                throw VerbesserungAbgelehnt.anfrage("kennzahl");
            }
            kennzahlen.fuerBezugsbasis(kennzahl, null, null, null);
            sql.append("AND a.kennzahl_id = ? ");
            args.add(kennzahl);
        }
        sql.append("ORDER BY a.kennzeichen");
        ZoneId zone = zone();
        LocalDate abruf = LocalDate.ofInstant(kennzahlen.jetzt(), zone);
        Map<UUID, Boolean> lesbar = new HashMap<>();
        List<AbweichungDto.Abweichung> aus = new ArrayList<>();
        for (Map<String, Object> z : jdbc.queryForList(sql.toString(), args.toArray())) {
            UUID kz = (UUID) z.get("kennzahl_id");
            if (!lesbar.computeIfAbsent(kz, x -> kennzahlen.lesbareKennzahlOderNichts(x) != null)) {
                continue;
            }
            AbweichungDto.Abweichung a = dto(z, zone, abruf, null, null);
            if (nurUeberfaellig != null && nurUeberfaellig != "ueberfaellig".equals(a.frist().faellig())) {
                continue;
            }
            aus.add(a);
        }
        return new AbweichungDto.Liste(abruf, List.copyOf(aus));
    }

    /** Die Abweichung mit ihren Vermerken und dem Verlauf; außerhalb der Sicht 404. */
    public AbweichungDto.Abweichung eine(UUID id) {
        Map<String, Object> z = sichtbar(id);
        ZoneId zone = zone();
        List<AbweichungDto.Vermerk> vermerke = jdbc.queryForList(VERMERK + "WHERE v.abweichung_id = ? ORDER BY v.periode",
                id).stream().map(v -> vermerk(v, zone)).toList();
        return dto(z, zone, LocalDate.ofInstant(kennzahlen.jetzt(), zone), vermerke, verlauf(id));
    }

    // ================================================================================ von Hand (A3)

    /** A3: von Hand an Vergleichszeilen — Anlass-Kopie aus dem Leser und ein Wortlaut, warum. */
    public AbweichungDto.Abweichung anlegen(AbweichungDto.Anlegen a, ProtokollAkteur wer) {
        if (a == null || a.kennzahl() == null) {
            throw VerbesserungAbgelehnt.anfrage("kennzahl");
        }
        KennzahlService.BasisKennzahl k = kennzahlen.fuerBezugsbasis(a.kennzahl(), VERWALTEN, wer, null);
        String wortlaut = a.wortlaut() == null ? "" : a.wortlaut().strip();
        if (wortlaut.length() < 10 || wortlaut.length() > 500) {
            throw VerbesserungAbgelehnt.fachlich("wortlaut_fehlt", "Eine Abweichung von Hand sagt in 10 bis 500 "
                    + "Zeichen, warum sie untersucht wird.", Map.of("feld", "wortlaut", "min", 10, "max", 500));
        }
        ZoneId zone = zone();
        LocalDate heute = LocalDate.ofInstant(k.jetzt(), zone);
        YearMonth[] spanne = monate(a.monate(), YearMonth.from(heute));
        Map<String, Object> person = verantwortlich(a.verantwortlich());
        fristNichtVor(a.frist(), heute);

        BezugsbasisVergleich.ZielVergleich zv = vergleich.fuerZiel(a.kennzahl(), a.bezugsbasis(), spanne[0], spanne[1]);
        BezugsbasisVergleichDto.Vergleich ver = zv.vergleich();
        if (ver.bezugsbasis() == null) {
            throw VerbesserungAbgelehnt.fachlich("kennzahl_ohne_bezugsbasis", "Eine Abweichung zitiert den Vergleich "
                    + "mit einer freigegebenen Bezugsbasis — diese Kennzahl hat keine.",
                    Map.of("kennzahl", k.zeile().kennzeichen()));
        }
        Set<Integer> fassungen = new LinkedHashSet<>();
        for (BezugsbasisVergleichDto.Monat m : ver.monate()) {
            if (m.bereinigt().fassung() == null) {
                throw VerbesserungAbgelehnt.fachlich("monat_ohne_fassung", "Für " + KennzahlRegeln.periodeText("monat",
                        m.periode()) + " gilt keine freigegebene Fassung der Bezugsbasis.", Map.of("monat", m.periode()));
            }
            fassungen.add(m.bereinigt().fassung().fassung());
        }
        if (fassungen.size() != 1) {
            throw VerbesserungAbgelehnt.fachlich("monate_verschiedene_fassungen", "Eine Abweichung zitiert genau eine "
                    + "Fassung der Bezugsbasis; die gewählten Monate lesen verschiedene.",
                    Map.of("fassungen", List.copyOf(fassungen)));
        }
        int fassung = fassungen.iterator().next();
        String anlass = BerichtRegeln.kanonisch(anlassVonHand(k.zeile().kennzeichen(), ver.bezugsbasis().kennzeichen(),
                fassung, spanne, ver));
        List<String> monate = new ArrayList<>();
        for (YearMonth m = spanne[0]; !m.isAfter(spanne[1]); m = m.plusMonths(1)) {
            monate.add(m.toString());
        }
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        UUID standort = kennzahlen.geltungFuerBericht(a.kennzahl()).standort();
        UUID neu = schreiben(() -> transaktion.execute(s -> (UUID) eroeffnen(tenant, a.kennzahl(),
                ver.bezugsbasis().id(), fassung, monate, "von_hand", wortlaut, anlass, person, a.frist(), standort,
                k.jetzt(), wer).get("id")));
        return eine(neu);
    }

    /** Die Kopie (Muster Ausgangslage der Maßnahme): Anker und je Monat das Ergebnis des Lesers, dazu der Zeitraum. */
    private JsonNode anlassVonHand(String kennzahl, String basis, int fassung, YearMonth[] spanne,
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

    // ================================================================================ Einträge, Frist, Verantwortlicher (A4)

    /** A4/U1/U2: ein Kommentar oder eine Ursache-Aussage (Person, Tag, wahlfrei Beleg) — nur an einer offenen. */
    public AbweichungDto.Abweichung eintrag(UUID id, AbweichungDto.NeuerEintrag e, ProtokollAkteur wer) {
        offen(schreibbar(id, VERWALTEN, wer));
        if (e == null) {
            throw VerbesserungAbgelehnt.anfrage("");
        }
        String art = e.art() == null ? "kommentar" : e.art();
        if (!VerbesserungRegeln.VOKABULARE.get("abweichung_eintrag_art").contains(art)) {
            throw VerbesserungAbgelehnt.anfrage("art");
        }
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        if (art.equals("kommentar")) {
            if (e.wortlaut() != null || e.aussageSub() != null || e.aussageName() != null || e.aussageAm() != null
                    || e.belegKennung() != null) {
                throw VerbesserungAbgelehnt.anfrage("art");
            }
            String text = e.text() == null ? "" : e.text().strip();
            if (text.isEmpty() || text.length() > 2000) {
                throw VerbesserungAbgelehnt.fachlich("text_ungueltig", "Ein Kommentar hat 1 bis 2 000 Zeichen.",
                        Map.of("min", 1, "max", 2000));
            }
            transaktion.executeWithoutResult(s -> protokoll(tenant, id, "kommentar", null, null, null, text, null, wer));
            return eine(id);
        }
        if (e.text() != null) {
            throw VerbesserungAbgelehnt.anfrage("text");
        }
        String wortlaut = e.wortlaut() == null ? "" : e.wortlaut().strip();
        if (wortlaut.length() < 10 || wortlaut.length() > 500) {
            throw VerbesserungAbgelehnt.fachlich("wortlaut_fehlt", "Eine Ursache-Aussage hat 10 bis 500 Zeichen.",
                    Map.of("feld", "wortlaut", "min", 10, "max", 500));
        }
        String sub = null;
        String name = e.aussageName() == null ? null : e.aussageName().strip();
        if (e.aussageSub() != null) {
            Map<String, Object> b = benutzer(e.aussageSub());
            sub = (String) b.get("sub");
            if (name == null || name.isEmpty()) {
                name = (String) b.get("name");
            }
        }
        if (name == null || name.isEmpty()) {
            throw VerbesserungAbgelehnt.fachlich("aussage_ohne_person", "Eine Ursache ist immer die Aussage einer "
                    + "Person — bitte nennen Sie, von wem sie ist.", Map.of("feld", "aussage_name"));
        }
        LocalDate heute = LocalDate.ofInstant(kennzahlen.jetzt(), zone());
        if (e.aussageAm() == null) {
            throw VerbesserungAbgelehnt.anfrage("aussage_am");
        }
        if (e.aussageAm().isAfter(heute)) {
            throw VerbesserungAbgelehnt.fachlich("aussage_in_der_zukunft", "Eine Aussage ist an einem Tag gemacht, "
                    + "der schon war.", Map.of("aussage_am", e.aussageAm().toString(), "heute", heute.toString()));
        }
        String beleg = e.belegKennung() == null ? null : e.belegKennung().strip();
        if (beleg != null && (beleg.isEmpty() || beleg.length() > 200)) {
            throw VerbesserungAbgelehnt.anfrage("beleg_kennung");
        }
        Object[] aussage = {wortlaut, sub, name, Date.valueOf(e.aussageAm()), beleg};
        transaktion.executeWithoutResult(s -> protokoll(tenant, id, "ursache_aussage", null, null, null, null, aussage,
                wer));
        return eine(id);
    }

    /** A4: die Frist (nie vor dem Eröffnungstag) mit Begründung — solange offen. */
    public AbweichungDto.Abweichung frist(UUID id, AbweichungDto.Frist f, ProtokollAkteur wer) {
        Map<String, Object> z = offen(schreibbar(id, VERWALTEN, wer));
        if (f == null || f.frist() == null) {
            throw VerbesserungAbgelehnt.anfrage("frist");
        }
        String begruendung = begruendung(f.begruendung());
        ZoneId zone = zone();
        fristNichtVor(f.frist(), LocalDate.ofInstant(((Timestamp) z.get("eroeffnet_am")).toInstant(), zone));
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        String alt = ((Date) z.get("frist")).toLocalDate().toString();
        schreiben(() -> transaktion.execute(s -> {
            jdbc.update("UPDATE abweichung SET frist = ? WHERE id = ?", Date.valueOf(f.frist()), id);
            protokoll(tenant, id, "abweichung_geaendert", Map.of("frist", alt), Map.of("frist", f.frist().toString()),
                    begruendung, null, null, wer);
            return id;
        }));
        return eine(id);
    }

    /** A4/RE3: ein aktives Konto des Kundenbereichs als Schnappschuss, mit Begründung — solange offen. */
    public AbweichungDto.Abweichung verantwortlicher(UUID id, AbweichungDto.Verantwortlicher v, ProtokollAkteur wer) {
        Map<String, Object> z = offen(schreibbar(id, VERWALTEN, wer));
        if (v == null || v.benutzer() == null || v.benutzer().isBlank()) {
            throw VerbesserungAbgelehnt.anfrage("benutzer");
        }
        String begruendung = begruendung(v.begruendung());
        Map<String, Object> b = verantwortlich(v.benutzer());
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        schreiben(() -> transaktion.execute(s -> {
            jdbc.update("UPDATE abweichung SET verantwortlich_sub = ?, verantwortlich_name = ?, verantwortlich_konto = ? "
                    + "WHERE id = ?", b.get("sub"), b.get("name"), b.get("konto"), id);
            protokoll(tenant, id, "verantwortlicher_geaendert", Map.of("verantwortlich_name",
                    z.get("verantwortlich_name")), Map.of("verantwortlich_name", b.get("name")), begruendung, null,
                    null, wer);
            return id;
        }));
        return eine(id);
    }

    // ================================================================================ Abschluss (A6)

    /** A6: offen → abgeschlossen, einmalig, mit Ergebnis und Begründung; bei {@code massnahme} der Verweis Pflicht. */
    public AbweichungDto.Abweichung abschliessen(UUID id, AbweichungDto.Abschliessen a, ProtokollAkteur wer) {
        Map<String, Object> z = offen(schreibbar(id, ABSCHLIESSEN, wer));
        if (a == null || a.ergebnis() == null
                || !VerbesserungRegeln.VOKABULARE.get("abweichung_ergebnis").contains(a.ergebnis())) {
            throw VerbesserungAbgelehnt.anfrage("ergebnis");
        }
        Map<String, Object> massnahme = null;
        if (a.ergebnis().equals("massnahme")) {
            if (a.massnahme() == null) {
                throw VerbesserungAbgelehnt.fachlich("massnahme_fehlt", "Das Ergebnis „Maßnahme“ nennt die Maßnahme "
                        + "(M-…), die aus der Abweichung folgt.", Map.of("feld", "massnahme"));
            }
            massnahme = massnahme(a.massnahme());
        } else if (a.massnahme() != null) {
            throw VerbesserungAbgelehnt.anfrage("massnahme");
        }
        String begruendung = begruendung(a.begruendung());
        UUID tenant = Objects.requireNonNull(TenantContext.get(), "kein Kundenbereich");
        Instant jetzt = kennzahlen.jetzt();
        Map<String, Object> neu = new LinkedHashMap<>();
        neu.put("zustand", "abgeschlossen");
        neu.put("ergebnis", a.ergebnis());
        if (massnahme != null) {
            neu.put("massnahme", massnahme.get("kennzeichen"));
        }
        schreiben(() -> transaktion.execute(s -> {
            int n = jdbc.update("UPDATE abweichung SET zustand = 'abgeschlossen', ergebnis = ?, massnahme_id = ?, "
                    + "abschluss_begruendung = ?, abgeschlossen_am = ?, abgeschlossen_sub = ?, abgeschlossen_name = ?, "
                    + "abgeschlossen_rolle = ?, abgeschlossen_art = ? WHERE id = ? AND zustand = 'offen'",
                    a.ergebnis(), a.massnahme(), begruendung, Timestamp.from(jetzt), wer.sub(), wer.name(),
                    wer.rolle(), wer.art(), id);
            if (n != 1) {
                throw nichtOffen(z);
            }
            protokoll(tenant, id, "abweichung_abgeschlossen", Map.of("zustand", OFFEN), neu, begruendung, null, null,
                    wer);
            return id;
        }));
        return eine(id);
    }

    // ================================================================================ Eröffnen

    /** Legt die Abweichung an (Kennzeichen und Frist-Vorgabe vom Trigger) und schreibt {@code abweichung_eroeffnet}. */
    private Map<String, Object> eroeffnen(UUID tenant, UUID kennzahl, UUID basis, int fassung, List<String> monate,
            String herkunft, String wortlaut, String anlass, Map<String, Object> person, LocalDate frist,
            UUID standort, Instant jetzt, ProtokollAkteur wer) {
        Map<String, Object> neu = jdbc.queryForMap("INSERT INTO abweichung (tenant_id, kennzahl_id, bezugsbasis_id, "
                + "fassung, monate, herkunft_art, herkunft_wortlaut, anlass, anlass_pruefsumme, verantwortlich_sub, "
                + "verantwortlich_name, verantwortlich_konto, frist, standort_id, actor_sub, actor_name, actor_rolle, "
                + "actor_art, eroeffnet_am) VALUES (?, ?, ?, ?, ?::text[], ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                + "RETURNING id, kennzeichen, frist", tenant, kennzahl, basis, fassung, "{" + String.join(",", monate)
                + "}", herkunft, wortlaut, anlass, BerichtRegeln.pruefsumme(anlass), person.get("sub"),
                person.get("name"), person.get("konto"), frist == null ? null : Date.valueOf(frist), standort,
                wer.sub(), wer.name(), wer.rolle(), wer.art(), Timestamp.from(jetzt));
        Map<String, Object> inhalt = new LinkedHashMap<>();
        inhalt.put("zustand", OFFEN);
        inhalt.put("herkunft", herkunft);
        inhalt.put("monate", monate);
        inhalt.put("frist", neu.get("frist").toString());
        inhalt.put("verantwortlich_name", person.get("name"));
        inhalt.put("anlass_pruefsumme", BerichtRegeln.pruefsumme(anlass));
        protokoll(tenant, (UUID) neu.get("id"), "abweichung_eroeffnet", null, inhalt, null, null, null, wer);
        return neu;
    }

    // ================================================================================ Prüfungen

    /** Sichtbar über RLS ({@code site_scope}) und über die Kennzahl (404). */
    private Map<String, Object> sichtbar(UUID id) {
        Map<String, Object> z = jdbc.queryForList(ABWEICHUNG + "WHERE a.id = ?", id).stream().findFirst()
                .orElseThrow(AbweichungService::nichtGefunden);
        if (kennzahlen.lesbareKennzahlOderNichts((UUID) z.get("kennzahl_id")) == null) {
            throw nichtGefunden();
        }
        return z;
    }

    /** Sichtbar (404) und {@code recht} an der Geltung der Kennzahl (403). */
    private Map<String, Object> schreibbar(UUID id, String recht, ProtokollAkteur wer) {
        Map<String, Object> z = sichtbar(id);
        kennzahlen.fuerBezugsbasis((UUID) z.get("kennzahl_id"), recht, wer, null);
        return z;
    }

    private static Map<String, Object> offen(Map<String, Object> z) {
        if (!OFFEN.equals(z.get("zustand"))) {
            throw nichtOffen(z);
        }
        return z;
    }

    private static VerbesserungAbgelehnt nichtOffen(Map<String, Object> z) {
        return new VerbesserungAbgelehnt(409, "abweichung_abgeschlossen", "Die Abweichung " + z.get("kennzeichen")
                + " ist abgeschlossen; der Abschluss ist einmalig.", Map.of("zustand", String.valueOf(z.get("zustand"))));
    }

    private static VerbesserungAbgelehnt beantwortet(Map<String, Object> v) {
        return new VerbesserungAbgelehnt(409, "auffaelligkeit_beantwortet", "Die Auffälligkeit "
                + KennzahlRegeln.periodeText("monat", (String) v.get("periode")) + " ist schon beantwortet; die Antwort "
                + "ist einmalig.", Map.of("periode", v.get("periode")));
    }

    static VerbesserungAbgelehnt nichtGefunden() {
        return new VerbesserungAbgelehnt(404, "nicht_gefunden", "Diese Abweichung gibt es nicht.", null);
    }

    static VerbesserungAbgelehnt vermerkNichtGefunden() {
        return new VerbesserungAbgelehnt(404, "nicht_gefunden", "Diese Auffälligkeit gibt es nicht.", null);
    }

    /** Eine sichtbare Maßnahme (RLS und ihre Kennzahl), sonst 422 {@code massnahme_unbekannt}. */
    private Map<String, Object> massnahme(UUID id) {
        Map<String, Object> m = jdbc.queryForList("SELECT id, kennzeichen, kennzahl_id FROM massnahme WHERE id = ?", id)
                .stream().findFirst().orElse(null);
        if (m == null || (m.get("kennzahl_id") != null
                && kennzahlen.lesbareKennzahlOderNichts((UUID) m.get("kennzahl_id")) == null)) {
            throw VerbesserungAbgelehnt.fachlich("massnahme_unbekannt", "Diese Maßnahme gibt es in Ihrem "
                    + "Kundenbereich nicht.", Map.of("feld", "massnahme"));
        }
        return m;
    }

    /** Die Frist ist ein Tag ab dem Eröffnungstag (Zeitzone des Unternehmens), sonst 422. */
    private static void fristNichtVor(LocalDate frist, LocalDate eroeffnet) {
        if (frist != null && frist.isBefore(eroeffnet)) {
            throw VerbesserungAbgelehnt.fachlich("frist_vor_eroeffnung", "Die Frist liegt nicht vor dem Tag, an dem "
                    + "die Abweichung eröffnet wurde.", Map.of("frist", frist.toString(), "eroeffnet_am",
                            eroeffnet.toString()));
        }
    }

    /** {@code JJJJ-MM} oder {@code JJJJ-MM/JJJJ-MM}, abgeschlossen, höchstens 12 Monate. */
    private static YearMonth[] monate(String text, YearMonth dieser) {
        if (text == null) {
            throw VerbesserungAbgelehnt.anfrage("monate");
        }
        String[] teile = text.strip().split("/", -1);
        if (teile.length > 2 || !MONAT.matcher(teile[0]).matches()
                || (teile.length == 2 && !MONAT.matcher(teile[1]).matches())) {
            throw VerbesserungAbgelehnt.anfrage("monate");
        }
        YearMonth von = YearMonth.parse(teile[0]);
        YearMonth bis = teile.length == 2 ? YearMonth.parse(teile[1]) : von;
        if (bis.isBefore(von) || ChronoUnit.MONTHS.between(von, bis) + 1 > HOECHSTENS_MONATE) {
            throw VerbesserungAbgelehnt.anfrage("monate");
        }
        if (!bis.isBefore(dieser)) {
            throw VerbesserungAbgelehnt.fachlich("monate_nicht_abgeschlossen", "Eine Abweichung zitiert "
                    + "abgeschlossene Monate.", Map.of("feld", "monate", "spaetestens", dieser.minusMonths(1).toString()));
        }
        return new YearMonth[] {von, bis};
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
        return benutzer(sub);
    }

    private Map<String, Object> benutzer(String sub) {
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

    /** Die Trigger von IP-14 als Ablehnung mit Code; alles andere bleibt ein Fehler. */
    private <T> T schreiben(java.util.function.Supplier<T> weg) {
        try {
            return weg.get();
        } catch (DataIntegrityViolationException x) {
            String grund = String.valueOf(x.getMostSpecificCause().getMessage());
            for (String[] c : new String[][] {
                {"abweichung_abschluss_einmalig", "abweichung_abgeschlossen"},
                {"abweichung_identitaet_bleibt", "abweichung_abgeschlossen"},
                {"auffaelligkeit_antwort_einmalig", "auffaelligkeit_beantwortet"},
                {"auffaelligkeit_abweichung_passt_chk", "abweichung_passt_nicht"},
                {"_fassung_freigegeben_chk", "fassung_nicht_freigegeben"},
                {"_basis_der_kennzahl_chk", "basis_nicht_der_kennzahl"},
                {"_monat_in_der_fassung_chk", "monat_ausserhalb_der_fassung"},
                {"_standort_der_kennzahl_chk", "standort_der_kennzahl"},
                {"abweichung_massnahme_fk", "massnahme_unbekannt"}}) {
                if (grund.contains(c[0])) {
                    int status = c[1].equals("abweichung_abgeschlossen") || c[1].equals("auffaelligkeit_beantwortet")
                            ? 409 : 422;
                    throw new VerbesserungAbgelehnt(status, c[1], "Die Abweichung wurde so nicht gespeichert.",
                            Map.of("grund", c[0]));
                }
            }
            throw x;
        }
    }

    // ================================================================================ Protokoll und Darstellung

    /** {@code aussage}: Wortlaut, Konto, Name, Tag, Beleg — nur bei {@code ursache_aussage}. */
    private void protokoll(UUID tenant, UUID id, String art, Map<String, Object> alt, Map<String, Object> neu,
            String begruendung, String kommentar, Object[] aussage, ProtokollAkteur wer) {
        Object[] a = aussage == null ? new Object[5] : aussage;
        jdbc.update("INSERT INTO abweichung_aenderung (tenant_id, abweichung_id, art, alt, neu, begruendung, kommentar, "
                + "aussage_wortlaut, aussage_sub, aussage_name, aussage_am, beleg_kennung, actor_sub, actor_name, "
                + "actor_rolle, actor_art) VALUES (?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                tenant, id, art, text(alt), text(neu), begruendung, kommentar, a[0], a[1], a[2], a[3], a[4], wer.sub(),
                wer.name(), wer.rolle(), wer.art());
    }

    private List<AbweichungDto.Eintrag> verlauf(UUID id) {
        return jdbc.query("SELECT id, art, alt::text AS alt, neu::text AS neu, begruendung, kommentar, aussage_wortlaut, "
                + "aussage_sub, aussage_name, aussage_am, beleg_kennung, actor_name, created_at FROM abweichung_aenderung "
                + "WHERE abweichung_id = ? ORDER BY created_at, id", (rs, i) -> {
                    AbweichungDto.Aussage aussage = null;
                    if (rs.getString("aussage_wortlaut") != null) {
                        aussage = aussage(rs.getString("aussage_wortlaut"), rs.getString("aussage_sub"),
                                rs.getString("aussage_name"), rs.getDate("aussage_am").toLocalDate(),
                                rs.getString("beleg_kennung"));
                    }
                    return new AbweichungDto.Eintrag(rs.getLong("id"), rs.getString("art"), map(rs.getString("alt")),
                            map(rs.getString("neu")), rs.getString("begruendung"), rs.getString("kommentar"), aussage,
                            rs.getString("actor_name"), rs.getTimestamp("created_at").toInstant());
                }, id);
    }

    /** U1/U2: immer „Aussage von …“ — mit Beleg „mit Beleg …“, ohne „keine Messung“. */
    static AbweichungDto.Aussage aussage(String wortlaut, String sub, String name, LocalDate am, String beleg) {
        String tag = TAG.format(am);
        String kennzeichen = "Aussage von " + name + ", " + tag + " — "
                + (beleg == null ? "keine Messung" : "mit Beleg " + beleg);
        Map<String, String> werte = new LinkedHashMap<>();
        werte.put("person", name);
        werte.put("am", tag);
        if (beleg != null) {
            werte.put("beleg", beleg);
        }
        werte.put("wortlaut", wortlaut);
        return new AbweichungDto.Aussage(wortlaut, sub, name, am, beleg, kennzeichen,
                satz(beleg == null ? "ursache_aussage" : "ursache_aussage_mit_beleg", werte));
    }

    private AbweichungDto.Vermerk einVermerk(UUID id, ZoneId zone) {
        return vermerk(jdbc.queryForList(VERMERK + "WHERE v.id = ?", id).stream().findFirst()
                .orElseThrow(AbweichungService::vermerkNichtGefunden), zone);
    }

    private AbweichungDto.Vermerk vermerk(Map<String, Object> z, ZoneId zone) {
        String anlass = (String) z.get("anlass");
        Map<String, Object> inhalt = map(anlass);
        String periode = (String) z.get("periode");
        Timestamp beantwortet = (Timestamp) z.get("beantwortet_am");
        UUID aw = (UUID) z.get("abweichung_id");
        String satz = null;
        if ("zur_kenntnis".equals(z.get("antwort"))) {
            String[] d = delta(inhalt);
            if (d != null && d[2] != null && d[3] != null) {
                Map<String, String> werte = new LinkedHashMap<>();
                werte.put("monat", KennzahlRegeln.periodeText("monat", periode));
                werte.put("prozent", EnergiezielService.prozent(d[0], d[1]));
                werte.put("urteil", d[2]);
                werte.put("band", BezugsbasisVergleichSatz.band(d[3]));
                werte.put("person", (String) z.get("beantwortet_name"));
                werte.put("am", TAG.format(LocalDate.ofInstant(beantwortet.toInstant(), zone)));
                werte.put("begruendung", (String) z.get("antwort_begruendung"));
                satz = satz("auffaelligkeit_zur_kenntnis", werte);
            }
        }
        return new AbweichungDto.Vermerk((UUID) z.get("id"),
                new AbweichungDto.Verweis((UUID) z.get("kennzahl_id"), (String) z.get("kz"), (String) z.get("kz_name")),
                new AbweichungDto.Verweis((UUID) z.get("bezugsbasis_id"), (String) z.get("bb"), null),
                ((Number) z.get("fassung")).intValue(), periode, (UUID) z.get("standort_id"), anlass,
                (String) z.get("anlass_pruefsumme"), inhalt, vorbehalte(baum(anlass)),
                ((Timestamp) z.get("vermerkt_am")).toInstant(), (String) z.get("zustand"), (String) z.get("antwort"),
                (String) z.get("antwort_begruendung"),
                aw == null ? null : new AbweichungDto.Verweis(aw, (String) z.get("aw"), null),
                beantwortet == null ? null : beantwortet.toInstant(), (String) z.get("beantwortet_name"), satz);
    }

    private AbweichungDto.Abweichung dto(Map<String, Object> z, ZoneId zone, LocalDate abruf,
            List<AbweichungDto.Vermerk> vermerke, List<AbweichungDto.Eintrag> verlauf) {
        String kennzeichen = (String) z.get("kennzeichen");
        String zustand = (String) z.get("zustand");
        String person = (String) z.get("verantwortlich_name");
        LocalDate frist = ((Date) z.get("frist")).toLocalDate();
        String anlass = (String) z.get("anlass");
        Map<String, Object> inhalt = map(anlass);
        List<String> monate = monateAus(z.get("monate"));
        Map<String, Object> f = VerbesserungRegeln.frist(new VerbesserungRegeln.FristEingang("abweichung", zustand,
                frist.toString(), null, null, abruf.toString()));

        AbweichungDto.Abschluss abschluss = null;
        if (!OFFEN.equals(zustand)) {
            String ergebnis = (String) z.get("ergebnis");
            UUID mId = (UUID) z.get("massnahme_id");
            LocalDate am = LocalDate.ofInstant(((Timestamp) z.get("abgeschlossen_am")).toInstant(), zone);
            String wer = (String) z.get("abgeschlossen_name");
            String begruendung = (String) z.get("abschluss_begruendung");
            Map<String, String> werte = new LinkedHashMap<>();
            werte.put("am", TAG.format(am));
            werte.put("person", wer);
            if (mId != null) {
                werte.put("massnahme", (String) z.get("mk"));
            }
            werte.put("begruendung", begruendung);
            String satz = switch (ergebnis) {
                case "massnahme" -> satz("abschluss_massnahme", werte);
                case "erklaert" -> satz("abschluss_erklaert", werte);
                default -> null;
            };
            abschluss = new AbweichungDto.Abschluss(ergebnis, mId == null ? null
                    : new AbweichungDto.Verweis(mId, (String) z.get("mk"), (String) z.get("m_titel")), begruendung, am,
                    wer, satz);
        }

        String kopf = null;
        String[] d = delta(inhalt);
        if (d != null) {
            Map<String, String> werte = new LinkedHashMap<>();
            werte.put("kennzeichen", kennzeichen);
            werte.put("kennzahl", z.get("kz") + " " + z.get("kz_name"));
            werte.put("monate", KennzahlRegeln.periodeText("monat", monate.get(0)));
            werte.put("prozent", EnergiezielService.prozent(d[0], d[1]));
            werte.put("person", person);
            werte.put("frist", TAG.format(frist));
            werte.put("zustand", zustand);
            kopf = monate.size() == 1 ? satz("abweichung_kopf", werte) : null;
        }
        return new AbweichungDto.Abweichung((UUID) z.get("id"), kennzeichen,
                new AbweichungDto.Verweis((UUID) z.get("kennzahl_id"), (String) z.get("kz"), (String) z.get("kz_name")),
                new AbweichungDto.Verweis((UUID) z.get("bezugsbasis_id"), (String) z.get("bb"), null),
                ((Number) z.get("fassung")).intValue(), monate,
                new AbweichungDto.Herkunft((String) z.get("herkunft_art"), (String) z.get("herkunft_wortlaut")), anlass,
                (String) z.get("anlass_pruefsumme"), inhalt, vorbehalte(baum(anlass)),
                new AbweichungDto.Person((String) z.get("verantwortlich_sub"), person),
                new AbweichungDto.FristStand(abruf, frist, (String) f.get("faellig"), (Integer) f.get("seit_tagen")),
                (UUID) z.get("standort_id"), zustand,
                LocalDate.ofInstant(((Timestamp) z.get("eroeffnet_am")).toInstant(), zone),
                (String) z.get("actor_name"), abschluss, kopf, vermerke, verlauf);
    }

    /**
     * R8: die Vorbehalte des Anlasses — jedes Kennzeichen mit „vorläufig“, wie es in der Kopie steht (geerbt, nicht neu
     * gebildet: AP-17 G5), in der Reihenfolge des Auftretens.
     */
    static List<String> vorbehalte(JsonNode anlass) {
        Set<String> aus = new LinkedHashSet<>();
        sammle(anlass, aus);
        return List.copyOf(aus);
    }

    private static void sammle(JsonNode n, Set<String> aus) {
        if (n == null) {
            return;
        }
        if (n.isObject()) {
            n.fields().forEachRemaining(e -> {
                if (e.getKey().equals("kennzeichen") && e.getValue().isArray()) {
                    e.getValue().forEach(k -> {
                        if (k.isTextual() && k.asText().contains("vorläufig")) {
                            aus.add(k.asText());
                        }
                    });
                } else {
                    sammle(e.getValue(), aus);
                }
            });
        } else if (n.isArray()) {
            n.forEach(x -> sammle(x, aus));
        }
    }

    /**
     * Δ, Richtung, Urteil und Band eines Anlasses aus EINEM Monat: die Kopie eines Vermerks ({@code delta_prozent} …
     * oben) oder die des Lesers ({@code vergleich[0].bereinigt}); sonst {@code null} — der Satz bleibt dann leer.
     */
    @SuppressWarnings("unchecked")
    private static String[] delta(Map<String, Object> inhalt) {
        if (inhalt == null) {
            return null;
        }
        Map<String, Object> quelle = inhalt;
        Object vergleich = inhalt.get("vergleich");
        if (vergleich instanceof List<?> l) {
            if (l.size() != 1) {
                return null;
            }
            quelle = (Map<String, Object>) ((Map<String, Object>) l.get(0)).get("bereinigt");
        } else if (inhalt.get("vermerke") instanceof List<?> l) {
            return l.size() == 1 ? delta((Map<String, Object>) l.get(0)) : null;
        }
        if (quelle == null || quelle.get("delta_prozent") == null) {
            return null;
        }
        String delta = String.valueOf(quelle.get("delta_prozent"));
        Object r = quelle.get("richtung");
        String richtung = r != null ? r.toString() : delta.startsWith("-") ? "weniger" : "mehr";
        Object band = quelle.get("band_prozent");
        return new String[] {delta, richtung, (String) quelle.get("urteil"), band == null ? null : band.toString()};
    }

    private static List<String> monateAus(Object feld) {
        try {
            return feld instanceof java.sql.Array a ? Arrays.asList((String[]) a.getArray()) : List.of();
        } catch (SQLException x) {
            throw new IllegalStateException(x);
        }
    }

    private JsonNode baum(String text) {
        try {
            return json.readTree(text);
        } catch (com.fasterxml.jackson.core.JsonProcessingException x) {
            throw new IllegalStateException(x);
        }
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

    /** Die Zeitzone des Unternehmens (Eröffnungstag, „heute“, Frist). */
    private ZoneId zone() {
        return ZoneId.of(jdbc.queryForList("SELECT zeitzone FROM unternehmen LIMIT 1", String.class).stream()
                .filter(Objects::nonNull).findFirst().orElse("Europe/Berlin"));
    }

    private static String satz(String schluessel, Map<String, String> werte) {
        Object s = VerbesserungRegeln.satz(schluessel, werte).get("satz");
        return s == null ? null : s.toString();
    }
}
