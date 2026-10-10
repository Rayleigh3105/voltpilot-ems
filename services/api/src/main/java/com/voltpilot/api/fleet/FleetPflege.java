package com.voltpilot.api.fleet;

import com.voltpilot.api.repo.AdminFleetRepository.ExportCeiling;
import com.voltpilot.api.repo.AdminFleetRepository.ForecastRow;
import com.voltpilot.api.repo.AdminFleetRepository.PvPeak;
import com.voltpilot.api.uems.GrenzeAufloesung;
import com.voltpilot.api.web.dto.AdminFleetDto.FleetFeedInDto;
import com.voltpilot.api.web.dto.AdminFleetDto.FleetForecastDto;
import com.voltpilot.api.web.dto.AdminFleetDto.FleetKwpDto;
import com.voltpilot.api.web.dto.AdminFleetDto.PflegeFlagDto;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/**
 * Die PFLEGE-Ableitung des Flotten-Pulses (Baustein B4, Vollausbau): rechnet aus
 * gepflegten Stammdaten und gemessenen Reihen die offenen Punkte je Anlage.
 *
 * <p>Reine Funktionen, keine I/O - genau wie {@code Tagesprotokoll},
 * {@code SlotEconomics} oder {@code Ereignisse}: die Regeln sind damit ohne
 * Docker prüfbar ({@code FleetPflegeTest}), und der Controller bleibt reine
 * Verdrahtung.
 *
 * <p><b>Fünf Regeln, jede mit ihrem eigenen Ehrlichkeits-Gewissen:</b>
 *
 * <ol>
 *   <li><b>Stromtarif fehlt</b> - reiner EXISTENZ-Check auf {@code tarif_art =
 *       'ohne'}: die Anlage rechnet dann mit Standard-Komponenten statt mit den
 *       Preisen des Kunden. Nie eine zweite Preisrechnung.</li>
 *   <li><b>Speicher ohne Gerät</b> - der Plan entsteht, wird aber nie
 *       veröffentlicht.</li>
 *   <li><b>kWp unplausibel</b> - gemessene PV-Spitze gegen gepflegte
 *       Nennleistung, siehe {@link #kwp}.</li>
 *   <li><b>Einspeisegrenze unplausibel</b> - gemessene Export-Decke gegen die
 *       wirksame Grenze aus Anlage und Grenzblatt, siehe {@link #feedIn}.</li>
 *   <li><b>Prognose auffällig</b> - der normierte Prognosefehler dieser Anlage
 *       gegen den Flotten-MEDIAN, siehe {@link #forecastChecks}.</li>
 * </ol>
 */
public final class FleetPflege {

    // ---- kWp-Plausibilität ---------------------------------------------------

    /**
     * Ab hier ist die gemessene Spitze zu HOCH: {@value} × die gepflegte
     * Nennleistung. Die Wechselrichter-AC-Ausgangsleistung liegt bauartbedingt
     * UNTER der DC-Modulleistung (in Deutschland typisch bei 0,7-0,9 kW je kWp);
     * ein Viertel ÜBER der Nennleistung kann keine Anlage physikalisch liefern -
     * das ist ein Skalierungs- oder Konfigurationsfehler (der reale Präzedenzfall
     * ist der Deye-Register-Faktor 10, der aus 3 MW „30 MW" machte).
     */
    static final double KWP_HIGH_FACTOR = 1.25;

    /**
     * Ab hier ist die gemessene Spitze zu NIEDRIG: unter {@value} × Nennleistung
     * über das ganze Fenster. Bewusst weit unter jedem Wetter-Effekt (selbst ein
     * durchgehend trüber Monat erreicht in Mitteleuropa Spitzen über einem
     * Viertel der Nennleistung); das fängt den dokumentierten Fall „ein zweiter,
     * nie zugeordneter Wechselrichter" und eine schlicht falsche kWp-Zahl.
     */
    static final double KWP_LOW_FACTOR = 0.25;

    /**
     * So viele Viertelstunden MIT PV-Wert braucht das Fenster mindestens (ein
     * Tag), bevor irgendjemand über Plausibilität urteilen darf. Darunter fehlt
     * die Grundlage - und das wird gesagt, statt geraten.
     */
    static final long KWP_MIN_BUCKETS = 96;

    // ---- Einspeisegrenze-Plausibilität ---------------------------------------

    /**
     * So viele bewertete Export-Tage braucht eine Anlage mindestens, bevor über
     * ihre Einspeisegrenze geurteilt wird. Darunter (frische Anlage, Winter mit
     * kaum Einspeisung, eine wetterschwache Woche) fehlt die Grundlage - und das
     * wird benannt, nie geraten. Fängt zugleich den Fehlalarm „kleine PV, schwache
     * Wochen" ab: eine Anlage, die selten überhaupt einspeist, wird nie beurteilt.
     */
    static final int FEED_IN_MIN_EXPORT_DAYS = 5;

    /**
     * So viele Tage müssen an DERSELBEN Decke kleben, bevor „klebt wiederholt"
     * behauptet werden darf. Das ist die eigentliche Fehlalarm-Bremse: eine hart
     * gekappte Anlage trifft ihre Decke Tag für Tag am selben Wert; eine Anlage,
     * deren Einspeisung schlicht mit dem Wetter schwankt, hat ihre Tages-Maxima
     * über den Bereich verteilt und erreicht diese Zahl nie.
     */
    static final int FEED_IN_CLING_MIN_DAYS = 5;

    /**
     * Die Drift-Richtung 1 (der Pilsting-Fall): erst wenn die gemessene Decke
     * unter {@value} × der gepflegten Grenze liegt, ist die Grenze DEUTLICH zu
     * hoch. Pilsting: 30 gemessen ≤ 75 × 0,7 = 52,5 ⇒ schlägt an. Eine Anlage, die
     * ihre korrekt gepflegte Grenze schlicht nicht ganz erreicht (Decke 29 bei
     * Grenze 30), bleibt still.
     */
    static final double FEED_IN_DRIFT_FACTOR = 0.7;

    /**
     * Die Drift-Richtung 2: erst wenn die robuste Decke über {@value} × der
     * Grenze liegt, wird die Grenze wiederholt und DEUTLICH überschritten - die
     * Grenze wird nicht gehalten oder ist zu niedrig gepflegt. Weil die Decke das
     * 90.-Perzentil der Tages-Maxima ist, bedeutet „darüber" schon an sich eine
     * WIEDERHOLTE Überschreitung, kein einzelner Ausreißer.
     */
    static final double FEED_IN_OVERSHOOT_FACTOR = 1.1;

    /**
     * Unter {@value} kW exportiert eine Anlage praktisch nicht - es gibt keine
     * Decke, an der sie „kleben" könnte, und ein Drift-Hinweis „klebt bei 0 kW
     * unter 75 kW" wäre ein Fehlalarm. Darunter fällt das Urteil deshalb auf
     * {@code ok} zurück (nichts zu pflegen), nie auf {@code zu_hoch}.
     */
    static final double FEED_IN_PLATEAU_MIN_KW = 1.0;

    // ---- Prognose-Ausreißer --------------------------------------------------

    /**
     * Ab dem {@value}-fachen des Flotten-Medians gilt eine Anlage als Ausreißer.
     * Der Maßstab ist die FLOTTE, nicht eine geeichte Schwelle - dieselbe
     * Disziplin wie beim Edge-Stand („es gibt kein Release-Register, also ist
     * die neueste gemeldete Version der Maßstab").
     */
    static final double FORECAST_OUTLIER_FACTOR = 1.5;

    /**
     * ...aber nie unterhalb von {@value} % normiertem Fehler. Ohne diesen Boden
     * würde in einer durchweg guten Flotte (Median 8 %) schon eine völlig
     * gesunde Anlage bei 13 % als Ausreißer markiert - Alarm-Müdigkeit auf einer
     * ungeeichten Schwelle ist genau das, was der Puls nicht produzieren soll.
     */
    static final double FORECAST_FLOOR_PCT = 25.0;

    /**
     * So viele bewertete Anlagen braucht eine Prognoseart mindestens, bevor ihr
     * Median ein Maßstab ist. Bei zwei Anlagen ist „der Median" nur die andere
     * Anlage.
     */
    static final int FORECAST_MIN_FLEET = 3;

    /** So viele bewertete Tage braucht eine Anlage, um mitgezählt zu werden. */
    static final int FORECAST_MIN_DAYS = 3;

    /** Die deutschen Namen der Prognosearten (unbekannte Art: der Rohname). */
    private static final Map<String, String> KIND_LABEL = Map.of(
            "load", "Verbrauch",
            "pv", "PV");

    private FleetPflege() {
    }

    /**
     * Die kWp-Plausibilität einer Anlage.
     *
     * <p>Vier Urteile, und drei davon sind ein „ich weiß es nicht" mit Grund:
     * ohne gepflegte Nennleistung, ohne Rollup-Fenster und ohne genug
     * Viertelstunden wird NICHT geurteilt. Erst wenn beide Seiten vorliegen,
     * vergleicht die Regel die höchste gemessene Viertelstunden-Mittelleistung
     * mit der Nennleistung.
     */
    public static FleetKwpDto kwp(BigDecimal configuredKwp, PvPeak peak) {
        BigDecimal peakKw = peak == null ? null : peak.peakKw();
        long buckets = peak == null ? 0 : peak.buckets();
        if (configuredKwp == null || configuredKwp.signum() <= 0) {
            return new FleetKwpDto(configuredKwp, peakKw, buckets, "unbekannt",
                    "Keine PV-Nennleistung gepflegt - ohne kWp ist die gemessene Spitze nicht"
                            + " einzuordnen.");
        }
        if (peak == null || buckets < KWP_MIN_BUCKETS) {
            return new FleetKwpDto(configuredKwp, peakKw, buckets, "unbekannt",
                    "Noch zu wenige Messwerte (" + buckets + " Viertelstunden) für ein Urteil.");
        }
        double kwp = configuredKwp.doubleValue();
        double measured = peakKw == null ? 0.0 : peakKw.doubleValue();
        if (measured > kwp * KWP_HIGH_FACTOR) {
            return new FleetKwpDto(configuredKwp, peakKw, buckets, "zu_hoch",
                    "Gemessene PV-Spitze " + kw(measured) + " über " + kw(kwp)
                            + "p installiert - das deutet auf einen Skalierungsfehler.");
        }
        if (measured <= 0.0) {
            return new FleetKwpDto(configuredKwp, peakKw, buckets, "zu_niedrig",
                    "Keine PV-Leistung gemessen, obwohl " + kw(kwp) + "p gepflegt sind.");
        }
        if (measured < kwp * KWP_LOW_FACTOR) {
            return new FleetKwpDto(configuredKwp, peakKw, buckets, "zu_niedrig",
                    "Gemessene PV-Spitze nur " + kw(measured) + " bei " + kw(kwp)
                            + "p installiert - fehlt ein Erzeuger?");
        }
        return new FleetKwpDto(configuredKwp, peakKw, buckets, "ok",
                "Gemessene PV-Spitze " + kw(measured) + " bei " + kw(kwp) + "p installiert.");
    }

    /**
     * Die Plausibilität der gepflegten Einspeisegrenze (B4c) - dem B4a-kWp-Muster
     * folgend, nur für {@code max_feed_in_kw} statt der Nennleistung.
     *
     * <p>Vier Urteile, und drei davon sind ein ehrliches „ich weiß es nicht" mit
     * Grund: ohne gepflegte Grenze, ohne genug Export-Tage bleibt es
     * {@code unbekannt}. Liegt beides vor, prüft die Regel zwei Richtungen:
     *
     * <ul>
     *   <li><b>{@code nicht_gehalten}</b> - die robuste Decke überschreitet die
     *       Grenze wiederholt und deutlich (Richtung 2). Zuerst geprüft, weil eine
     *       überschrittene Compliance-Grenze das dringendere Signal ist.</li>
     *   <li><b>{@code zu_hoch}</b> - die Anlage KLEBT wiederholt (mindestens
     *       {@link #FEED_IN_CLING_MIN_DAYS} Tage) an einer Decke, die DEUTLICH
     *       unter der Grenze liegt (Richtung 1, der Pilsting-Fall). Beide
     *       Bedingungen zusammen halten Fehlalarme fern: eine kleine PV / schwache
     *       Wochen bilden keine stabile Decke, und eine korrekt (niedrig)
     *       gepflegte Grenze liegt nicht deutlich über der Decke.</li>
     * </ul>
     *
     * <p>Bewusste, ehrliche Grenze (im {@code reason} als „vermutlich" gehalten):
     * eine kleine Anlage an einem großzügig dimensionierten Netzanschluss klebt
     * an ihrer Wechselrichter-Decke unter der (korrekten) Anschlussgrenze und
     * kann {@code zu_hoch} auslösen. Das ist ein HINWEIS zum Nachsehen, keine
     * Behauptung - genau wie B4a die Frage „fehlt ein Erzeuger?" stellt.
     */
    public static FleetFeedInDto feedIn(BigDecimal configuredKw, ExportCeiling c) {
        return feedIn(configuredKw, null, c);
    }

    /** Wie {@link #feedIn(BigDecimal, ExportCeiling)}, mit sichtbarer Herkunft einer wirksamen Grenzblatt-Grenze. */
    public static FleetFeedInDto feedIn(BigDecimal configuredKw, String quelleEinspeisung, ExportCeiling c) {
        BigDecimal ceilingKw = c == null ? null : c.ceilingKw();
        int exportDays = c == null ? 0 : c.exportDays();
        int clingDays = c == null ? 0 : c.clingDays();
        if (configuredKw == null || configuredKw.signum() <= 0) {
            return new FleetFeedInDto(configuredKw, ceilingKw, exportDays, clingDays, "unbekannt",
                    "Keine Einspeisegrenze gepflegt - ohne Grenze ist die gemessene Einspeisung nicht"
                            + " einzuordnen.");
        }
        if (c == null || exportDays < FEED_IN_MIN_EXPORT_DAYS) {
            return new FleetFeedInDto(configuredKw, ceilingKw, exportDays, clingDays, "unbekannt",
                    "Noch zu wenige Export-Tage (" + exportDays + ") für ein Urteil.");
        }
        double limit = configuredKw.doubleValue();
        double ceiling = ceilingKw == null ? 0.0 : ceilingKw.doubleValue();
        if (ceiling >= limit * FEED_IN_OVERSHOOT_FACTOR) {
            return new FleetFeedInDto(configuredKw, ceilingKw, exportDays, clingDays, "nicht_gehalten",
                    "Gemessene Einspeisung erreicht wiederholt " + kw(ceiling) + " über der "
                            + grenze(quelleEinspeisung) + " " + kw(limit)
                            + " - die Grenze wird nicht gehalten oder ist zu niedrig gepflegt.");
        }
        if (ceiling >= FEED_IN_PLATEAU_MIN_KW && clingDays >= FEED_IN_CLING_MIN_DAYS
                && ceiling <= limit * FEED_IN_DRIFT_FACTOR) {
            return new FleetFeedInDto(configuredKw, ceilingKw, exportDays, clingDays, "zu_hoch",
                    "Die Anlage klebt an " + clingDays + " Tagen bei " + kw(ceiling) + ", die "
                            + grenze(quelleEinspeisung) + " " + kw(limit)
                            + " liegt deutlich darüber - vermutlich zu hoch gepflegt.");
        }
        return new FleetFeedInDto(configuredKw, ceilingKw, exportDays, clingDays, "ok",
                "Gemessene Einspeise-Decke " + kw(ceiling) + " bei " + grenze(quelleEinspeisung) + " "
                        + kw(limit) + ".");
    }

    private static String grenze(String quelleEinspeisung) {
        return GrenzeAufloesung.QUELLE_NETZANSCHLUSS.equals(quelleEinspeisung)
                ? "wirksamer Einspeisegrenze aus dem Grenzblatt" : "gepflegter Einspeisegrenze";
    }

    /**
     * Die Prognose-Ausreißer über die ganze Flotte, je Anlage und Prognoseart.
     *
     * <p>Der Maßstab ist der MEDIAN der Flotte für DIESE Prognoseart (nie über
     * Arten hinweg gemittelt - Last- und PV-Fehler sind verschiedene Größen),
     * und ein Ausreißer ist, wer {@link #FORECAST_OUTLIER_FACTOR}× darüber UND
     * über dem Boden {@link #FORECAST_FLOOR_PCT} liegt. Gibt es weniger als
     * {@link #FORECAST_MIN_FLEET} bewertete Anlagen, existiert kein Maßstab -
     * dann wird NICHTS als Ausreißer markiert und der Grund benennt das.
     *
     * <p>Anlagen mit zu wenigen bewerteten Tagen zählen weder für den Median
     * noch als Ausreißer; sie tauchen mit ihrem Grund auf.
     */
    public static Map<UUID, List<FleetForecastDto>> forecastChecks(List<ForecastRow> rows) {
        Map<String, List<Double>> byKind = new HashMap<>();
        for (ForecastRow r : rows) {
            if (r.days() >= FORECAST_MIN_DAYS) {
                byKind.computeIfAbsent(r.kind(), k -> new ArrayList<>()).add(r.nmaePct());
            }
        }
        Map<String, Double> medians = new HashMap<>();
        for (Map.Entry<String, List<Double>> e : byKind.entrySet()) {
            if (e.getValue().size() >= FORECAST_MIN_FLEET) {
                medians.put(e.getKey(), median(e.getValue()));
            }
        }

        Map<UUID, List<FleetForecastDto>> out = new HashMap<>();
        for (ForecastRow r : rows) {
            String kindLabel = KIND_LABEL.getOrDefault(r.kind(), r.kind());
            Double fleetMedian = medians.get(r.kind());
            FleetForecastDto dto;
            if (r.days() < FORECAST_MIN_DAYS) {
                dto = new FleetForecastDto(r.kind(), r.nmaePct(), r.days(), fleetMedian, false,
                        "Erst " + r.days() + " bewertete Tage - noch kein Urteil zur "
                                + kindLabel + "-Prognose.");
            } else if (fleetMedian == null) {
                dto = new FleetForecastDto(r.kind(), r.nmaePct(), r.days(), null, false,
                        "Zu wenige bewertete Anlagen in der Flotte - kein Maßstab für die "
                                + kindLabel + "-Prognose.");
            } else {
                double threshold = Math.max(FORECAST_FLOOR_PCT, fleetMedian * FORECAST_OUTLIER_FACTOR);
                boolean outlier = r.nmaePct() > threshold;
                dto = new FleetForecastDto(r.kind(), r.nmaePct(), r.days(), fleetMedian, outlier,
                        "Ø Abweichung " + pct(r.nmaePct()) + " bei der " + kindLabel
                                + "-Prognose, Flotte " + pct(fleetMedian) + ".");
            }
            out.computeIfAbsent(r.siteId(), k -> new ArrayList<>()).add(dto);
        }
        for (List<FleetForecastDto> list : out.values()) {
            list.sort(Comparator.comparing(FleetForecastDto::kind));
        }
        return out;
    }

    /**
     * Die offenen Pflege-Punkte einer Anlage, in fester Reihenfolge. Eine leere
     * Liste heißt „nichts offen" - und weil jede Regel eine Datenlage
     * voraussetzt, heißt sie nie „nicht geprüft" (das steht in
     * {@code kwp.reason} bzw. im Prognose-Grund).
     */
    public static List<PflegeFlagDto> flags(String tarifArt, boolean batteryWithoutDevice,
            FleetKwpDto kwp, FleetFeedInDto feedIn, List<FleetForecastDto> forecast) {
        List<PflegeFlagDto> out = new ArrayList<>();
        if ("ohne".equals(tarifArt)) {
            out.add(new PflegeFlagDto("tarif-fehlt", "Stromtarif fehlt",
                    "Die Anlage rechnet mit Standard-Komponenten statt mit den Preisen des Kunden."));
        }
        if (batteryWithoutDevice) {
            out.add(new PflegeFlagDto("speicher-ohne-geraet", "Speicher ohne Gerät",
                    "Der Fahrplan entsteht, wird aber nie an ein Gerät veröffentlicht."));
        }
        if (kwp != null && ("zu_hoch".equals(kwp.verdict()) || "zu_niedrig".equals(kwp.verdict()))) {
            out.add(new PflegeFlagDto("kwp-unplausibel", "kWp unplausibel", kwp.reason()));
        }
        if (feedIn != null
                && ("zu_hoch".equals(feedIn.verdict()) || "nicht_gehalten".equals(feedIn.verdict()))) {
            out.add(new PflegeFlagDto("einspeisegrenze-unplausibel", "Einspeisegrenze unplausibel",
                    feedIn.reason()));
        }
        for (FleetForecastDto f : forecast == null ? List.<FleetForecastDto>of() : forecast) {
            if (f.outlier()) {
                out.add(new PflegeFlagDto("prognose-ausreisser-" + f.kind(), "Prognose auffällig",
                        f.reason()));
            }
        }
        return out;
    }

    /** Der Median einer nicht-leeren Werteliste (gerade Anzahl: das Mittel der Mitte). */
    static double median(List<Double> values) {
        List<Double> sorted = new ArrayList<>(values);
        sorted.sort(Comparator.naturalOrder());
        int n = sorted.size();
        return n % 2 == 1 ? sorted.get(n / 2) : (sorted.get(n / 2 - 1) + sorted.get(n / 2)) / 2.0;
    }

    private static String kw(double v) {
        return String.format(Locale.GERMANY, "%,.1f kW", v);
    }

    private static String pct(double v) {
        return String.format(Locale.GERMANY, "%,.0f %%", v);
    }
}
