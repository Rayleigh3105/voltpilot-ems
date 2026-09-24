package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * AP-18 NW-1: Ziele, Maßnahmen, Abweichungen — reine Regeln ({@code docs/contracts/v2/verbesserung.md}). Keine Fläche ruft
 * sie bisher auf. Zwillinge: {@code frontend/portal/src/verbesserung.ts} und {@code voltpilot_optimization/verbesserung.py};
 * alle drei fahren {@code verbesserung-vectors.json}. Δ, Band und Urteil je Monat und die Summe durch Summe sind die
 * Operationen {@code vergleich} und {@code zeitraum} von {@link BezugsbasisRegeln} — hier steht nur, welche Monate zählen,
 * der Vorschlag am Energieziel und die Frist. Die Uhr kommt von außen ({@code abruf}).
 */
public final class VerbesserungRegeln {
    private VerbesserungRegeln() {}

    public record Startwerte(int nachher_monate, int nachher_monate_hoechstens, int abweichung_frist_tage) {}
    public static final Startwerte STARTWERTE = new Startwerte(12, 36, 30);
    public static final Map<String, List<String>> VOKABULARE = vokabulare();
    /** Die Kundensätze (Report §5.9) als Schablonen; {@code {name}} füllt die Operation {@code satz}. */
    public static final Map<String, String> SAETZE = Map.ofEntries(
            Map.entry("auffaelligkeit", "Auffälligkeit: {monat} — {gemessen} gemessen, {erwartet} erwartet bei {bedingung}: {prozent} als die Bezugsbasis erwarten lässt ({urteil}, Band ± {band} %). Vermerkt am {am}. Abweichung eröffnen oder zur Kenntnis nehmen."),
            Map.entry("auffaelligkeit_zur_kenntnis", "Auffälligkeit {monat}: {prozent} als die Bezugsbasis erwarten lässt ({urteil}, Band ± {band} %) — zur Kenntnis genommen von {person} am {am}: ‚{begruendung}‘"),
            Map.entry("abweichung_kopf", "Abweichung {kennzeichen} · {kennzahl}, {monate}: {prozent} als die Bezugsbasis erwarten lässt · Verantwortlich {person} · Frist {frist} · {zustand}."),
            Map.entry("ursache_aussage", "Ursache — Aussage von {person}, {am} (keine Messung): ‚{wortlaut}‘"),
            Map.entry("ursache_aussage_mit_beleg", "Ursache — Aussage von {person}, {am} (mit Beleg: {beleg}): ‚{wortlaut}‘"),
            Map.entry("abschluss_massnahme", "Abgeschlossen am {am} von {person}: Maßnahme {massnahme} — ‚{begruendung}‘"),
            Map.entry("abschluss_erklaert", "Abgeschlossen am {am} von {person}: erklärt — ‚{begruendung}‘"),
            Map.entry("massnahme_kopf", "{kennzeichen} · {titel} · Verantwortlich {person} · Termin {termin} · umgesetzt am {umgesetzt_am}."),
            Map.entry("messgrundlage", "Messgrundlage: {kennzahl}, Bezugsbasis {bezugsbasis}, Fassung {fassung} — bereinigt um {bereinigt_um} ({methode}). Ausgangslage {ausgangslage_monat}: {ausgangslage_prozent} als erwartet (Version {version}, Kopie vom {kopiert_am}). Erwartete Wirkung: {erwartete_wirkung} — ‚{wortlaut}‘"),
            Map.entry("ohne_messgrundlage", "{kennzeichen} · {titel} · ohne Messgrundlage — Wirkung nicht messbar. Um die Wirkung zu messen, braucht {einsatz} eine Energieleistungskennzahl ({hinweis})."),
            Map.entry("wirkung_vorlaeufig", "Wirkung von {massnahme}, beobachtet: {prozent} {energie} als die Bezugsbasis erwarten lässt ({zeitraum}, {monate} Monaten; {ausschluesse}) — erwartet waren {erwartete_wirkung}. Ob die Maßnahme das bewirkt hat, sagt eine Person."),
            Map.entry("wirkung_umsetzungsmonat", "{monat}: Umsetzungsmonat — nicht gezählt."),
            Map.entry("wirkung_nicht_bewertbar", "{monat}: nicht bewertbar — {grund}."),
            Map.entry("wirkung_basis_nach_umsetzung", "{monat}: nicht bewertbar — die Bezugsbasis {bezugsbasis}, Fassung {fassung} hat eine Referenzperiode ({referenzperiode}), die nach der Umsetzung endet; sie enthielte die Maßnahme."),
            Map.entry("bewertung_belegt", "Belegt von {person} am {am}: ‚{begruendung}‘ Beobachtet: {prozent} ({monate} Monaten). Stand Nr. {stand}, Prüfsumme {pruefsumme}"),
            Map.entry("bewertung_offen", "Beobachtet — nicht belegt. Eine Bewertung mit Begründung setzt eine Person."),
            Map.entry("bewertung_nicht_messbar", "Bewertet am {am} von {person}: nicht messbar — ‚{begruendung}‘"),
            Map.entry("energieziel_stand", "Energieziel {kennzeichen} · {wortlaut} · {zielperiode} · Verantwortlich {person}. Stand nach {monate} Monaten: {prozent} ({ausschluesse}). Bezugsbasis {bezugsbasis}, Fassung {fassung}."),
            Map.entry("energieziel_ende", "Energieziel {kennzeichen}, Zielperiode {zielperiode}: {prozent} {energie} als die Bezugsbasis erwarten lässt ({monate} Monaten; {ausschluesse}) — Zielwert {zielwert}. Über die ganze Zielperiode nicht bewertbar; die Bewertung trifft eine Person. Bewertet am {am} von {person}: {ergebnis}."),
            Map.entry("energieziel_vorschlag", "Zielwert {vorschlag}: {prozent} gegenüber {zielwert} ({monate} Monaten) — Vorschlag; bestätigen oder mit Begründung abweichen."),
            Map.entry("ueberfaellig", "{kennzeichen} · {zustand} · Termin {termin} · überfällig seit {tage} Tagen · {person}."),
            Map.entry("baustein", "Ziele und Maßnahmen — {ueberfaellig} · {umgesetzt} · {ziele}."),
            Map.entry("anstoss_ausgangslage_korrigiert", "Ausgangslage korrigiert: {korrektur} ({am}) — die Ausgangslage zitiert {monat} in Version {version_alt} ({prozent_alt} als erwartet), gültig ist Version {version_neu} ({prozent_neu}). Beibehalten mit Begründung oder neu kopieren."),
            Map.entry("leer", "Noch keine Energieziele, Maßnahmen oder Abweichungen. Sie entstehen aus Ihren Energieleistungskennzahlen: aus einer Auffälligkeit, aus einem Energieziel oder von Hand."),
            Map.entry("grenz_satz", "VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.")
    );

    public record MonatEingang(String monat, String referenzperiode, BezugsbasisRegeln.VergleichEingang vergleich) {}
    public record WirkungEingang(String umgesetzt_am, int nachher_monate, List<MonatEingang> monate) {}
    public record ZielstandEingang(String zielwert_prozent, String zielperiode, List<MonatEingang> monate) {}
    public record FristEingang(String art, String zustand, String termin, String zielperiode, Boolean letzter_monat_endgueltig, String abruf) {}

    private static final String NA = "nicht_anwendbar", OHNE = "ohne_urteil";
    private static final Pattern PERIODE = Pattern.compile("^(\\d{4})-(0[1-9]|1[0-2])/(\\d{4})-(0[1-9]|1[0-2])$");
    private static final Pattern PLATZ = Pattern.compile("\\{([a-z_]+)\\}");

    private static Map<String, List<String>> vokabulare() {
        var m = new LinkedHashMap<String, List<String>>();
        m.put("energieziel_zustand", List.of("offen", "bewertet", "beendet"));
        m.put("energieziel_ergebnis", List.of("erreicht", "verfehlt", "nicht_bewertbar"));
        m.put("zielstand_vorschlag", List.of("erreicht", "nicht_erreicht"));
        m.put("massnahme_zustand", List.of("geplant", "umgesetzt", "bewertet", "verworfen"));
        m.put("massnahme_herkunft", List.of("abweichung", "energieziel", "einsatz", "von_hand"));
        m.put("abweichung_zustand", List.of("offen", "abgeschlossen"));
        m.put("abweichung_ergebnis", List.of("massnahme", "erklaert", "keine_abweichung", "nicht_bewertbar"));
        m.put("abweichung_eintrag_art", List.of("kommentar", "ursache_aussage"));
        m.put("auffaelligkeit_zustand", List.of("offen", "beantwortet"));
        m.put("auffaelligkeit_antwort", List.of("abweichung", "zur_kenntnis"));
        m.put("ursache_beleg", List.of("keine_messung", "mit_beleg"));
        m.put("wirkung_ergebnis", List.of("belegt", "nicht_belegt", "nicht_messbar"));
        m.put("wirkung_grund", List.of("umsetzungsmonat", "basis_nach_umsetzung", "unvollstaendig", "basis_fehlt", "basis_beendet", "zu_wenig_perioden", "variable_fehlt", "variable_ausserhalb", "periode_nicht_zu_ende", "keine_werte"));
        m.put("anstoss_art", List.of("ausgangslage_korrigiert", "bewertung_korrigiert", "messgrundlage_beendet", "messgrundlage_neu_gefasst"));
        m.put("anstoss_zustand", List.of("offen", "beantwortet"));
        m.put("anstoss_antwort", List.of("bleibt", "neu_kopiert", "neu_bewertet"));
        m.put("frist_art", List.of("massnahme", "abweichung", "energieziel"));
        m.put("frist_faellig", List.of("ueberfaellig", "bewertung_faellig"));
        return m;
    }
    private static String plus(String monat, int n) { return YearMonth.parse(monat).plusMonths(n).toString(); }
    private static Map<String, Object> fehler(String grund) { return new LinkedHashMap<>(Map.of("fehler", grund)); }
    private static Map<String, Object> ng(String monat, String grund) {
        var m = new LinkedHashMap<String, Object>();
        m.put("monat", monat);
        m.put("grund", grund);
        return m;
    }

    /** Ein Monat zählt, wenn der Vergleich der Bezugsbasis ein Urteil trägt; sonst ihr Grund ({@code unvollstaendig} für ohne_urteil). */
    private static String einordnen(MonatEingang m) {
        var r = BezugsbasisRegeln.vergleich(m.vergleich());
        if (NA.equals(r.get("urteil"))) return (String) r.get("grund");
        return OHNE.equals(r.get("urteil")) ? "unvollstaendig" : null;
    }

    /** U5 der Bezugsbasis: Operation {@code zeitraum} über die zählenden Monate gegen die Fassung des letzten (P4). */
    private static Map<String, Object> summe(List<MonatEingang> zaehlen, int soll) {
        var aus = new LinkedHashMap<String, Object>();
        if (zaehlen.isEmpty()) {
            aus.put("urteil", NA);
            for (var k : List.of("gemessen", "erwartet", "delta_prozent", "band_prozent", "richtung")) aus.put(k, null);
            aus.put("kennzeichen", List.of());
            return aus;
        }
        var letzter = zaehlen.get(zaehlen.size() - 1).vergleich();
        var z = BezugsbasisRegeln.zeitraum(new BezugsbasisRegeln.ZeitraumEingang(letzter.fassung(), false, zaehlen.size(),
                zaehlen.stream().map(m -> new BezugsbasisRegeln.Monat(m.vergleich().abgeschlossen(), m.vergleich().gemessen(),
                        m.vergleich().variablen())).toList()));
        for (var k : List.of("urteil", "gemessen", "erwartet", "delta_prozent", "band_prozent", "richtung")) aus.put(k, z.get(k));
        @SuppressWarnings("unchecked") var kennzeichen = new ArrayList<>((List<String>) z.get("kennzeichen"));
        if (zaehlen.size() < soll) kennzeichen.add(zaehlen.size() + " von " + soll + " Monaten");
        aus.put("kennzeichen", kennzeichen);
        return aus;
    }

    /** WK1–WK4: Nachher-Monate ab dem Monat nach {@code umgesetzt_am}; Σ ÷ Σ über die bewertbaren; Ausschlüsse mit Grund. */
    public static Map<String, Object> wirkung(WirkungEingang e) {
        int n = e.nachher_monate();
        if (n < STARTWERTE.nachher_monate() || n > STARTWERTE.nachher_monate_hoechstens()) return fehler("nachher_monate");
        String umsetzung = e.umgesetzt_am().substring(0, 7), von = plus(umsetzung, 1), bis = plus(umsetzung, n);
        var nichtGezaehlt = new ArrayList<Map<String, Object>>();
        var zaehlen = new ArrayList<MonatEingang>();
        var endgueltig = new ArrayList<String>();
        for (var m : e.monate()) {
            String monat = m.monat();
            if (monat.equals(umsetzung)) { nichtGezaehlt.add(ng(monat, "umsetzungsmonat")); continue; }
            if (monat.compareTo(von) < 0 || monat.compareTo(bis) > 0) continue;
            endgueltig.add(monat);
            String rp = m.referenzperiode();
            String grund = rp != null && m.vergleich().fassung() != null && rp.substring(8).compareTo(umsetzung) >= 0
                    ? "basis_nach_umsetzung" : einordnen(m);
            if (grund != null) nichtGezaehlt.add(ng(monat, grund)); else zaehlen.add(m);
        }
        var aus = new LinkedHashMap<String, Object>();
        aus.put("nachher_von", von);
        aus.put("nachher_bis", bis);
        aus.put("umsetzungsmonat", umsetzung);
        aus.put("zeitraum_von", endgueltig.isEmpty() ? null : endgueltig.get(0));
        aus.put("zeitraum_bis", endgueltig.isEmpty() ? null : endgueltig.get(endgueltig.size() - 1));
        aus.put("monate_bewertbar", zaehlen.size());
        aus.put("monate_endgueltig", endgueltig.size());
        aus.put("monate_soll", n);
        aus.put("monate", zaehlen.size() + " von " + n);
        aus.put("vorlaeufig", endgueltig.size() < n);
        aus.put("nicht_gezaehlt", nichtGezaehlt);
        aus.putAll(summe(zaehlen, n));
        return aus;
    }

    /** Z3/Z4: Σ ÷ Σ über die endgültigen Monate der Zielperiode; Vorschlag nur, wenn alle Monate bewertbar sind. */
    public static Map<String, Object> zielstand(ZielstandEingang e) {
        if (!PERIODE.matcher(e.zielperiode()).matches()) return fehler("zielperiode_format");
        String von = e.zielperiode().substring(0, 7), bis = e.zielperiode().substring(8);
        if (bis.compareTo(von) < 0) return fehler("zielperiode_reihenfolge");
        int soll = (int) ChronoUnit.MONTHS.between(YearMonth.parse(von), YearMonth.parse(bis)) + 1;
        var nichtGezaehlt = new ArrayList<Map<String, Object>>();
        var zaehlen = new ArrayList<MonatEingang>();
        int endgueltig = 0;
        for (var m : e.monate()) {
            if (m.monat().compareTo(von) < 0 || m.monat().compareTo(bis) > 0) continue;
            endgueltig++;
            String grund = einordnen(m);
            if (grund != null) nichtGezaehlt.add(ng(m.monat(), grund)); else zaehlen.add(m);
        }
        var summe = summe(zaehlen, soll);
        String vorschlag = null;
        if (zaehlen.size() == soll) {
            var g = new BigDecimal((String) summe.get("gemessen"));
            var erw = new BigDecimal((String) summe.get("erwartet"));
            var ziel = new BigDecimal(e.zielwert_prozent());
            vorschlag = g.subtract(erw).multiply(BigDecimal.valueOf(100)).compareTo(ziel.multiply(erw)) <= 0 ? "erreicht" : "nicht_erreicht";
        }
        var aus = new LinkedHashMap<String, Object>();
        aus.put("zielperiode", e.zielperiode());
        aus.put("zielwert_prozent", e.zielwert_prozent());
        aus.put("monate_bewertbar", zaehlen.size());
        aus.put("monate_endgueltig", endgueltig);
        aus.put("monate_soll", soll);
        aus.put("monate", zaehlen.size() + " von " + soll);
        aus.put("vollstaendig", zaehlen.size() == soll);
        aus.put("nicht_gezaehlt", nichtGezaehlt);
        aus.put("vorschlag", vorschlag);
        aus.putAll(summe);
        return aus;
    }

    /** F1: „überfällig seit n Tagen“ / „Bewertung fällig seit n Tagen“ beim Abruf; die Uhr kommt von außen ({@code abruf}). */
    public static Map<String, Object> frist(FristEingang e) {
        String offen = switch (e.art()) {
            case "massnahme" -> "geplant";
            case "abweichung", "energieziel" -> "offen";
            default -> throw new IllegalArgumentException("frist_art: " + e.art());
        };
        boolean ziel = e.art().equals("energieziel");
        LocalDate termin = ziel ? YearMonth.parse(e.zielperiode().substring(8)).atEndOfMonth() : LocalDate.parse(e.termin());
        var aus = new LinkedHashMap<String, Object>();
        aus.put("termin", termin.toString());
        aus.put("faellig", null);
        aus.put("seit_tagen", null);
        if (!offen.equals(e.zustand()) || (ziel && !Boolean.TRUE.equals(e.letzter_monat_endgueltig()))) return aus;
        long tage = ChronoUnit.DAYS.between(termin, LocalDate.parse(e.abruf()));
        if (tage < 0) return aus;
        aus.put("faellig", ziel ? "bewertung_faellig" : "ueberfaellig");
        aus.put("seit_tagen", (int) tage);
        return aus;
    }

    /** SP4: die Schablone aus §5.9, jeder Platzhalter genau aus {@code werte} — kein Wert fehlt, keiner bleibt übrig. */
    public static Map<String, Object> satz(String schluessel, Map<String, String> werte) {
        String vorlage = SAETZE.get(schluessel);
        if (vorlage == null) return fehler("satz_unbekannt");
        var namen = new ArrayList<String>();
        Matcher t = PLATZ.matcher(vorlage);
        while (t.find()) namen.add(t.group(1));
        for (var n : namen) if (!werte.containsKey(n)) return fehler("wert_fehlt:" + n);
        var uebrig = new TreeSet<>(werte.keySet());
        uebrig.removeAll(namen);
        if (!uebrig.isEmpty()) return fehler("wert_uebrig:" + uebrig.first());
        var sb = new StringBuilder();
        Matcher f = PLATZ.matcher(vorlage);
        while (f.find()) f.appendReplacement(sb, Matcher.quoteReplacement(werte.get(f.group(1))));
        f.appendTail(sb);
        return new LinkedHashMap<>(Map.of("satz", sb.toString()));
    }
}
