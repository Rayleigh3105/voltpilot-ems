package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.BezugsbasisVergleichDto;
import com.voltpilot.api.web.dto.EnergiezielDto;
import com.voltpilot.api.web.dto.MassnahmeDto;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.YearMonth;
import java.util.ArrayList;
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
        Gelesen g = rechnen(m, n, new HashMap<>());
        Map<String, Object> r = g.r();
        MassnahmeDto.Messgrundlage mg = m.messgrundlage();
        YearMonth umsetzung = YearMonth.from(m.umgesetztAm());

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> ng = (List<Map<String, Object>>) r.get("nicht_gezaehlt");
        Map<String, String> grund = new LinkedHashMap<>();
        ng.forEach(a -> grund.put((String) a.get("monat"), (String) a.get("grund")));
        List<MassnahmeDto.WirkungMonat> monate = new ArrayList<>();
        for (BezugsbasisVergleich.ZielMonat z : g.zv().monate()) {
            String periode = z.zeile().periode();
            String gr = grund.get(periode);
            boolean gezaehlt = z.endgueltig() && gr == null && !periode.equals(umsetzung.toString());
            monate.add(new MassnahmeDto.WirkungMonat(periode, z.endgueltig(), gezaehlt, gr, monatSatz(z, gr, mg),
                    z.kennzahl(), z.zeile()));
        }

        MassnahmeDto.WirkungSumme summe = summe(r);
        int bewertbar = (int) r.get("monate_bewertbar");
        String monateSatz = (String) r.get("monate");

        String satz = null;
        if (bewertbar > 0) {
            // Die Ausschlüsse des Satzes sind die der Nachher-Monate; der Umsetzungsmonat hat seinen eigenen Satz.
            List<EnergiezielDto.Ausschluss> nachher = ng.stream()
                    .filter(a -> !"umsetzungsmonat".equals(a.get("grund")))
                    .map(a -> new EnergiezielDto.Ausschluss((String) a.get("monat"), (String) a.get("grund"))).toList();
            Map<String, String> werte = new LinkedHashMap<>();
            werte.put("massnahme", m.kennzeichen());
            werte.put("prozent", EnergiezielService.prozent(summe.deltaProzent(), summe.richtung()));
            werte.put("energie", g.energie());
            werte.put("zeitraum", EnergiezielService.periodeText(YearMonth.parse((String) r.get("zeitraum_von")),
                    YearMonth.parse((String) r.get("zeitraum_bis"))));
            werte.put("monate", monateSatz);
            werte.put("ausschluesse", EnergiezielService.ausschluesse(nachher, g.zeilen()));
            if (m.erwarteteWirkungProzent() != null) {
                werte.put("erwartete_wirkung",
                        EnergiezielService.zielwertText(new BigDecimal(m.erwarteteWirkungProzent())));
                satz = satz("wirkung_vorlaeufig", werte);
            } else {
                // Entscheid 12 (Befund 6): „Weiß ich noch nicht“ beim Planen - der Satz ohne „erwartet waren …“.
                satz = satz("wirkung_ohne_erwartung", werte);
            }
        }
        // Die Kurzform steht auch hier an der Maßnahme: die Seite zeigt dieselben Mengen wie die Liste.
        return new MassnahmeDto.Wirkung(m.mitWirkungKurz(kurzAus(m, g)), m.frist().abruf(), null,
                (String) r.get("umsetzungsmonat"),
                (String) r.get("nachher_von"), (String) r.get("nachher_bis"), List.copyOf(monate), bewertbar,
                (int) r.get("monate_endgueltig"), (int) r.get("monate_soll"), monateSatz, (boolean) r.get("vorlaeufig"),
                ng.stream().map(a -> new MassnahmeDto.WirkungAusschluss((String) a.get("monat"),
                        (String) a.get("grund"))).toList(), summe, satz, g.energie());
    }

    /**
     * Die Liste mit der beobachteten Wirkung in Kurzform je Maßnahme (Verbessern-Konzept v1 §6.5) - dieselbe Rechnung
     * wie {@link #lesen} mit der Vorgabe von 12 Nachher-Monaten, nur die Summe. Ohne Messgrundlage, vor der Umsetzung,
     * verworfen oder ohne bewertbaren Monat bleibt das Feld {@code null}; die Liste braucht so keinen Wirkungs-Abruf je
     * Maßnahme.
     */
    public MassnahmeDto.Liste mitKurzform(MassnahmeDto.Liste liste) {
        int n = VerbesserungRegeln.STARTWERTE.nachher_monate();
        // Je Kennzahl und Bezugsbasis EIN Lesen des Vergleichs über alle Nachher-Zeiträume der Liste: die Monatszeilen
        // hängen nicht am Fenster (jeder Monat gegen seine Fassung, gelesen ab dem Vormonat) - sonst läse die Liste den
        // Vergleich einmal je Maßnahme (gemessen: Sekunden statt Millisekunden).
        Map<String, YearMonth[]> fenster = new LinkedHashMap<>();
        Map<String, MassnahmeDto.Messgrundlage> grundlage = new HashMap<>();
        for (MassnahmeDto.Massnahme m : liste.massnahmen()) {
            if (m.messgrundlage() == null || m.umgesetztAm() == null) {
                continue;
            }
            YearMonth u = YearMonth.from(m.umgesetztAm());
            grundlage.putIfAbsent(schluessel(m), m.messgrundlage());
            fenster.merge(schluessel(m), new YearMonth[] {u, u.plusMonths(n)}, (a, b) -> new YearMonth[] {
                a[0].isBefore(b[0]) ? a[0] : b[0], a[1].isAfter(b[1]) ? a[1] : b[1]});
        }
        Map<String, BezugsbasisVergleich.ZielVergleich> gelesen = new HashMap<>();
        fenster.forEach((k, f) -> gelesen.put(k, vergleich.fuerZiel(grundlage.get(k).kennzahl().id(),
                grundlage.get(k).bezugsbasis().kennzeichen(), f[0], f[1])));
        Map<UUID, String> energie = new HashMap<>();
        List<MassnahmeDto.Massnahme> aus = new ArrayList<>();
        for (MassnahmeDto.Massnahme m : liste.massnahmen()) {
            BezugsbasisVergleich.ZielVergleich zv = gelesen.get(schluessel(m));
            aus.add(m.mitWirkungKurz(zv == null ? null : kurzAus(m, rechnen(m, n, energie, zv))));
        }
        return new MassnahmeDto.Liste(liste.abruf(), List.copyOf(aus));
    }

    private static String schluessel(MassnahmeDto.Massnahme m) {
        return m.messgrundlage() == null ? "" : m.messgrundlage().kennzahl().id() + "|" + m.messgrundlage().bezugsbasis().kennzeichen();
    }

    private static MassnahmeDto.WirkungKurz kurzAus(MassnahmeDto.Massnahme m, Gelesen g) {
        Map<String, Object> r = g.r();
        int bewertbar = (int) r.get("monate_bewertbar");
        if (bewertbar == 0 || r.get("gemessen") == null) {
            return null;
        }
        BigDecimal gemessen = new BigDecimal((String) r.get("gemessen"));
        BigDecimal erwartet = new BigDecimal((String) r.get("erwartet"));
        String erwarteteWirkung = m.erwarteteWirkungProzent() == null ? null
                : new BigDecimal(m.erwarteteWirkungProzent()).multiply(erwartet)
                        .divide(BigDecimal.valueOf(100), 0, RoundingMode.HALF_UP).toPlainString();
        return new MassnahmeDto.WirkungKurz((String) r.get("delta_prozent"), (String) r.get("richtung"),
                (String) r.get("urteil"), bewertbar, (int) r.get("monate_soll"), (String) r.get("monate"),
                (boolean) r.get("vorlaeufig"), (String) r.get("zeitraum_von"), (String) r.get("zeitraum_bis"),
                gemessen.toPlainString(), erwartet.toPlainString(),
                gemessen.subtract(erwartet).setScale(0, RoundingMode.HALF_UP).toPlainString(), erwarteteWirkung,
                g.einheit(), g.energie());
    }

    /** Was die Operation {@code wirkung} über den Nachher-Zeitraum liefert, mit den gelesenen Zeilen und dem Träger. */
    private record Gelesen(Map<String, Object> r, BezugsbasisVergleich.ZielVergleich zv,
            Map<String, BezugsbasisVergleichDto.Monat> zeilen, String energie, String einheit) {}

    /**
     * Die Vergleichszeilen vom Umsetzungsmonat bis N Monate danach und die Operation {@code wirkung} darüber - der
     * Umsetzungsmonat geht immer mit (er zählt nie, R6), von den Nachher-Monaten nur die endgültigen (WK2).
     */
    private Gelesen rechnen(MassnahmeDto.Massnahme m, int n, Map<UUID, String> energie) {
        MassnahmeDto.Messgrundlage mg = m.messgrundlage();
        YearMonth umsetzung = YearMonth.from(m.umgesetztAm());
        return rechnen(m, n, energie, vergleich.fuerZiel(mg.kennzahl().id(), mg.bezugsbasis().kennzeichen(),
                umsetzung, umsetzung.plusMonths(n)));
    }

    /** Wie oben über einen schon gelesenen Vergleich, der den Zeitraum der Maßnahme enthält (die Liste, je Kennzahl). */
    private Gelesen rechnen(MassnahmeDto.Massnahme m, int n, Map<UUID, String> energie,
            BezugsbasisVergleich.ZielVergleich gelesen) {
        MassnahmeDto.Messgrundlage mg = m.messgrundlage();
        YearMonth umsetzung = YearMonth.from(m.umgesetztAm());
        String von = umsetzung.toString();
        String bis = umsetzung.plusMonths(n).toString();
        List<BezugsbasisVergleich.ZielMonat> eigene = gelesen.monate().stream()
                .filter(z -> z.zeile().periode().compareTo(von) >= 0 && z.zeile().periode().compareTo(bis) <= 0).toList();
        BezugsbasisVergleich.ZielVergleich zv = new BezugsbasisVergleich.ZielVergleich(gelesen.vergleich(), eigene,
                gelesen.heute());
        List<VerbesserungRegeln.MonatEingang> eingang = new ArrayList<>();
        Map<String, BezugsbasisVergleichDto.Monat> zeilen = new LinkedHashMap<>();
        String einheit = null;
        for (BezugsbasisVergleich.ZielMonat z : zv.monate()) {
            zeilen.put(z.zeile().periode(), z.zeile());
            if (z.endgueltig() || z.zeile().periode().equals(umsetzung.toString())) {
                eingang.add(z.eingang());
            }
            if (einheit == null && z.zeile().bereinigt().gemessen() != null) {
                einheit = z.zeile().bereinigt().gemessen().einheit();
            }
        }
        Map<String, Object> r = VerbesserungRegeln.wirkung(new VerbesserungRegeln.WirkungEingang(
                m.umgesetztAm().toString(), n, eingang));
        return new Gelesen(r, zv, zeilen, energie.computeIfAbsent(mg.kennzahl().id(), this::energie), einheit);
    }

    private static MassnahmeDto.WirkungSumme summe(Map<String, Object> r) {
        @SuppressWarnings("unchecked")
        List<String> kennzeichen = (List<String>) r.get("kennzeichen");
        return new MassnahmeDto.WirkungSumme((String) r.get("gemessen"), (String) r.get("erwartet"),
                (String) r.get("delta_prozent"), (String) r.get("band_prozent"), (String) r.get("richtung"),
                (String) r.get("urteil"), List.copyOf(kennzeichen));
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
                null, null, List.of(), null, satz, null);
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
