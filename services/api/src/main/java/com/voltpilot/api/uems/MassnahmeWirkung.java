package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.BezugsbasisVergleichDto;
import com.voltpilot.api.web.dto.EnergiezielDto;
import com.voltpilot.api.web.dto.MassnahmeDto;
import java.math.BigDecimal;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Die Wirkung einer Maßnahme (UEMS AP-18 IP-11, WK1–WK5): ein Leser, kein gespeicherter Wert. Je Monat ab dem
 * Umsetzungsmonat bis N Monate danach die Vergleichszeile des Bezugsbasis-Lesers gegen die Fassung, die am letzten Tag
 * des Monats gilt ({@link BezugsbasisVergleich#fuerZiel}, P4); über den Umsetzungsmonat und die endgültigen
 * Nachher-Monate die Operation {@code wirkung} ({@link VerbesserungRegeln#wirkung}: Umsetzungsmonat „nicht gezählt“,
 * {@code basis_nach_umsetzung}, Σ ÷ Σ über die bewertbaren, „x von N“, „vorläufig“, Ausschlüsse mit Grund). Gerechnet
 * wird hier nichts — nie ein Mittel der Monats-Δ (NW-1).
 *
 * <p>Die erwartete Wirkung und die Ausgangslage (Kopie mit Prüfsumme, byte-gleich) stehen daneben in der Maßnahme; kein
 * Satz sagt, dass die Maßnahme gewirkt hat (WK5). Ohne Messgrundlage gibt es nur den Satz {@code ohne_messgrundlage}
 * und keine Zahl (M4); vor der Umsetzung gibt es noch keine Nachher-Monate ({@code nicht_umgesetzt}, kein Satz — §5.9
 * nennt keinen). Keine Bewertung (Stand Nr. n, IP-12).
 *
 * <p><b>Zaun:</b> wie {@link MassnahmeService#eine} — RLS {@code site_scope} und die Kennzahl, außerhalb 404. Die Uhr
 * ist die der Kennzahlen.
 */
@Service
public class MassnahmeWirkung {

    static final Set<String> PARAMETER = Set.of("monate");
    private static final Pattern ZAHL = Pattern.compile("[0-9]{1,3}");

    private final MassnahmeService massnahmen;
    private final KennzahlService kennzahlen;
    private final BezugsbasisVergleich vergleich;
    private final JdbcTemplate jdbc;

    public MassnahmeWirkung(MassnahmeService massnahmen, KennzahlService kennzahlen, BezugsbasisVergleich vergleich,
            JdbcTemplate jdbc) {
        this.massnahmen = massnahmen;
        this.kennzahlen = kennzahlen;
        this.vergleich = vergleich;
        this.jdbc = jdbc;
    }

    /** WK1–WK5: {@code monate} 12 … 36 (Vorgabe 12, sonst 400 {@code anfrage_ungueltig}). */
    public MassnahmeDto.Wirkung lesen(UUID id, Collection<String> parameter, String monateText) {
        MassnahmeDto.Massnahme m = massnahmen.ohneVerlauf(id);
        parameter.stream().filter(p -> !PARAMETER.contains(p)).findFirst().ifPresent(p -> {
            throw VerbesserungAbgelehnt.anfrage(p);
        });
        int n = nachherMonate(monateText);
        if (m.messgrundlage() == null) {
            return leer(m, "ohne_messgrundlage", m.ohneMessgrundlage().satz());
        }
        if (m.umgesetztAm() == null) {
            return leer(m, "nicht_umgesetzt", null);
        }

        MassnahmeDto.Messgrundlage mg = m.messgrundlage();
        YearMonth umsetzung = YearMonth.from(m.umgesetztAm());
        BezugsbasisVergleich.ZielVergleich zv = vergleich.fuerZiel(mg.kennzahl().id(), mg.bezugsbasis().kennzeichen(),
                umsetzung, umsetzung.plusMonths(n));
        // Der Umsetzungsmonat geht immer mit (er zählt nie, R6); von den Nachher-Monaten nur die endgültigen (WK2).
        List<VerbesserungRegeln.MonatEingang> eingang = new ArrayList<>();
        Map<String, BezugsbasisVergleichDto.Monat> zeilen = new LinkedHashMap<>();
        for (BezugsbasisVergleich.ZielMonat z : zv.monate()) {
            zeilen.put(z.zeile().periode(), z.zeile());
            if (z.endgueltig() || z.zeile().periode().equals(umsetzung.toString())) {
                eingang.add(z.eingang());
            }
        }
        Map<String, Object> r = VerbesserungRegeln.wirkung(new VerbesserungRegeln.WirkungEingang(
                m.umgesetztAm().toString(), n, eingang));

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> ng = (List<Map<String, Object>>) r.get("nicht_gezaehlt");
        Map<String, String> grund = new LinkedHashMap<>();
        ng.forEach(a -> grund.put((String) a.get("monat"), (String) a.get("grund")));
        List<MassnahmeDto.WirkungMonat> monate = new ArrayList<>();
        for (BezugsbasisVergleich.ZielMonat z : zv.monate()) {
            String periode = z.zeile().periode();
            String g = grund.get(periode);
            boolean gezaehlt = z.endgueltig() && g == null && !periode.equals(umsetzung.toString());
            monate.add(new MassnahmeDto.WirkungMonat(periode, z.endgueltig(), gezaehlt, g, monatSatz(z, g, mg),
                    z.kennzahl(), z.zeile()));
        }

        @SuppressWarnings("unchecked")
        List<String> kennzeichen = (List<String>) r.get("kennzeichen");
        MassnahmeDto.WirkungSumme summe = new MassnahmeDto.WirkungSumme((String) r.get("gemessen"),
                (String) r.get("erwartet"), (String) r.get("delta_prozent"), (String) r.get("band_prozent"),
                (String) r.get("richtung"), (String) r.get("urteil"), List.copyOf(kennzeichen));
        int bewertbar = (int) r.get("monate_bewertbar");
        String monateSatz = (String) r.get("monate");

        String satz = null;
        if (bewertbar > 0 && m.erwarteteWirkungProzent() != null) {
            // Die Ausschlüsse des Satzes sind die der Nachher-Monate; der Umsetzungsmonat hat seinen eigenen Satz.
            List<EnergiezielDto.Ausschluss> nachher = ng.stream()
                    .filter(a -> !"umsetzungsmonat".equals(a.get("grund")))
                    .map(a -> new EnergiezielDto.Ausschluss((String) a.get("monat"), (String) a.get("grund"))).toList();
            Map<String, String> werte = new LinkedHashMap<>();
            werte.put("massnahme", m.kennzeichen());
            werte.put("prozent", EnergiezielService.prozent(summe.deltaProzent(), summe.richtung()));
            werte.put("energie", energie(mg.kennzahl().id()));
            werte.put("zeitraum", EnergiezielService.periodeText(YearMonth.parse((String) r.get("zeitraum_von")),
                    YearMonth.parse((String) r.get("zeitraum_bis"))));
            werte.put("monate", monateSatz);
            werte.put("ausschluesse", EnergiezielService.ausschluesse(nachher, zeilen));
            werte.put("erwartete_wirkung", EnergiezielService.zielwertText(new BigDecimal(m.erwarteteWirkungProzent())));
            satz = satz("wirkung_vorlaeufig", werte);
        }
        return new MassnahmeDto.Wirkung(m, m.frist().abruf(), null, (String) r.get("umsetzungsmonat"),
                (String) r.get("nachher_von"), (String) r.get("nachher_bis"), List.copyOf(monate), bewertbar,
                (int) r.get("monate_endgueltig"), (int) r.get("monate_soll"), monateSatz, (boolean) r.get("vorlaeufig"),
                ng.stream().map(a -> new MassnahmeDto.WirkungAusschluss((String) a.get("monat"),
                        (String) a.get("grund"))).toList(), summe, satz);
    }

    /** WK2: ganze Zahl; die Grenzen prüft die Operation {@code wirkung} selbst ({@code fehler: nachher_monate}). */
    private static int nachherMonate(String text) {
        if (text == null) {
            return VerbesserungRegeln.STARTWERTE.nachher_monate();
        }
        if (!ZAHL.matcher(text).matches()) {
            throw VerbesserungAbgelehnt.anfrage("monate");
        }
        int n = Integer.parseInt(text);
        if (VerbesserungRegeln.wirkung(new VerbesserungRegeln.WirkungEingang("2000-01-01", n, List.of()))
                .containsKey("fehler")) {
            throw VerbesserungAbgelehnt.anfrage("monate");
        }
        return n;
    }

    private static MassnahmeDto.Wirkung leer(MassnahmeDto.Massnahme m, String grund, String satz) {
        return new MassnahmeDto.Wirkung(m, m.frist().abruf(), grund, null, null, null, List.of(), null, null, null,
                null, null, List.of(), null, satz);
    }

    /** §5.9 „Wirkung, Monat nicht gezählt“ und „Basis nach der Umsetzung“ — nur für einen Monat, der nicht zählt. */
    private static String monatSatz(BezugsbasisVergleich.ZielMonat z, String grund, MassnahmeDto.Messgrundlage mg) {
        if (grund == null) {
            return null;
        }
        String monat = KennzahlRegeln.periodeText("monat", z.zeile().periode());
        if ("umsetzungsmonat".equals(grund)) {
            return satz("wirkung_umsetzungsmonat", Map.of("monat", monat));
        }
        BezugsbasisVergleichDto.Fassung f = z.zeile().bereinigt().fassung();
        if ("basis_nach_umsetzung".equals(grund)) {
            String rp = f.referenzperiode();
            return satz("wirkung_basis_nach_umsetzung", Map.of("monat", monat, "bezugsbasis",
                    mg.bezugsbasis().kennzeichen(), "fassung", String.valueOf(f.fassung()), "referenzperiode",
                    EnergiezielService.periodeText(YearMonth.parse(rp.substring(0, 7)), YearMonth.parse(rp.substring(8)))));
        }
        return satz("wirkung_nicht_bewertbar", Map.of("monat", monat, "grund", grundText(grund, z)));
    }

    /**
     * „Produktionsmenge 390 000 kg außerhalb der Bezugsbasis (228 600–375 100 kg)“ — die Variable des Monatssatzes mit
     * der tolerierten Spannweite ihrer Fassung, an der die Operation {@code vergleich} gemessen hat (§5.9).
     */
    private static String grundText(String grund, BezugsbasisVergleich.ZielMonat z) {
        BezugsbasisVergleichSatz.Variable v = z.variable();
        String name = v == null ? "Einflussgröße" : v.name();
        return switch (grund) {
            case "variable_ausserhalb" -> {
                BezugsbasisRegeln.Spannweite sw = spannweite(z);
                yield sw == null || v.wert() == null ? name + " außerhalb der Bezugsbasis"
                        : name + " " + BezugsbasisVergleichSatz.zahl(v.wert()) + " " + v.einheit()
                                + " außerhalb der Bezugsbasis (" + BezugsbasisVergleichSatz.zahl(sw.toleriert_von())
                                + "–" + BezugsbasisVergleichSatz.zahl(sw.toleriert_bis()) + " " + v.einheit() + ")";
            }
            case "variable_fehlt" -> name + " ohne Wert";
            default -> EnergiezielService.GRUND.getOrDefault(grund, grund);
        };
    }

    /** Die Spannweite der Variable, die der Monatssatz nennt (ihre Stelle in der Bedingung der Vergleichszeile). */
    private static BezugsbasisRegeln.Spannweite spannweite(BezugsbasisVergleich.ZielMonat z) {
        BezugsbasisVergleichSatz.Variable v = z.variable();
        BezugsbasisRegeln.Fassung f = z.eingang().vergleich().fassung();
        if (v == null || f == null || f.spannweite() == null) {
            return null;
        }
        List<BezugsbasisVergleichDto.Bedingung> bedingung = z.zeile().bereinigt().bedingung();
        for (int i = 0; i < bedingung.size() && i < f.spannweite().size(); i++) {
            if (Objects.equals(bedingung.get(i).name(), v.name()) && Objects.equals(bedingung.get(i).wert(), v.wert())) {
                BezugsbasisRegeln.Spannweite sw = f.spannweite().get(i);
                return sw == null || sw.toleriert_von() == null || sw.toleriert_bis() == null ? null : sw;
            }
        }
        return null;
    }

    /** Der Energieträger des Zählers („Strom“): das Medium seiner Messstellen, bei keinem oder mehreren „Energie“. */
    private String energie(UUID kennzahl) {
        Set<String> medien = new LinkedHashSet<>();
        for (KennzahlRepository.EingangZeile e : kennzahlen.fuerBezugsbasis(kennzahl, null, null, null).eingaenge()) {
            if ("zaehler".equals(e.rolle()) && "messstelle".equals(e.art()) && e.objektId() != null) {
                medien.addAll(jdbc.queryForList("SELECT medium FROM messstelle WHERE id = ? AND medium IS NOT NULL",
                        String.class, e.objektId()));
            }
        }
        return medien.size() == 1 ? medien.iterator().next() : "Energie";
    }

    private static String satz(String schluessel, Map<String, String> werte) {
        Object s = VerbesserungRegeln.satz(schluessel, werte).get("satz");
        return s == null ? null : s.toString();
    }
}
