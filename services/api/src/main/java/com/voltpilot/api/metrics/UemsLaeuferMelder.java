package com.voltpilot.api.metrics;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * AP-14 IP-9 (§3.5, Schicht „Läufer“ und „Wächter über den Wächter“): die EINE Stelle, an der jeder
 * geplante UEMS-Läufer meldet, dass er gelaufen ist — und dass ein Lauf gescheitert ist.
 *
 * <p><b>Warum hier und nicht in der Datenbank.</b> Nur DREI Läufer halten heute einen Lauf-Stand fest
 * ({@code messreihe_viertelstunde_lauf}, {@code messreihe_tag_lauf}, {@code messreihe_luecke_lauf}); die
 * übrigen zehn stehen nur im Log. Ein Betreiber kann daraus nicht sehen, ob ein Hintergrundlauf steht.
 * Diese Lücke füllt der Melder — im Prozess, ohne neue Tabelle, ohne Schreibzug: er ist eine
 * BETRIEBSAUSKUNFT über diesen api-Prozess, kein Kundendatum. Mehrere Repliken melden jede ihren
 * eigenen Stand; die Alarm-Regel aggregiert (`min by (laeufer)`), wie bei {@code voltpilot_site_*}.
 *
 * <p><b>Ehrlichkeit nach einem Neustart.</b> Ein Läufer, der seit dem Start dieses Prozesses noch nie
 * gelaufen ist, meldet KEIN Alter — kein erfundenes 0. Sichtbar ist er trotzdem: über
 * {@code voltpilot_uems_laeufer_zustand{laeufer,zustand="nie"}} (dasselbe Muster wie
 * {@code voltpilot_site_telemetry_state}). Dasselbe gilt für einen abgeschalteten Läufer
 * ({@code zustand="aus"}) — er darf nie einen Daueralarm „steht“ erzeugen.
 *
 * <p><b>Er darf keinen Lauf brechen.</b> Jede Methode schluckt alles: ein Fehler beim MELDEN ist nie
 * ein Fehler des Laufs. Darum auch {@link #STUMM} — ein Melder ohne Bindung an die
 * Anwendungs-{@code MeterRegistry}, damit ein Läufer, den ein Test direkt baut, nie auf {@code null}
 * läuft und kein bestehender Konstruktor eine neue Pflichtabhängigkeit bekommt.
 *
 * <p>Gelesen wird der Stand ausschließlich vom {@link UemsMetricsCollector} in dessen eigenem Takt —
 * <b>ein Prometheus-Scrape löst hier nichts aus</b> (das Muster von {@code DbStorageMetricsCollector}).
 */
@Component
public class UemsLaeuferMelder {

    private static final Logger log = LoggerFactory.getLogger(UemsLaeuferMelder.class);

    /**
     * Prometheus: {@code voltpilot_uems_laeufer_fehler_total}, Tag {@code laeufer}. Micrometer hängt
     * das {@code _total} beim Schreiben an — genau wie bei {@code voltpilot_zugriff_bestand}.
     */
    public static final String FEHLER = "voltpilot_uems_laeufer_fehler";

    /**
     * Prometheus: {@code voltpilot_uems_bestandslaeufer_total}, Tags {@code laeufer} und
     * {@code ergebnis} ({@code erledigt} | {@code fehler}) — gezählt in KUNDENBEREICHEN, weil die Frage
     * der Schicht „Übernahme“ lautet: haben die drei Bestands-Läufer jeden erreicht?
     */
    public static final String BESTAND = "voltpilot_uems_bestandslaeufer";

    /** Ein Kundenbereich, den ein Bestands-Läufer ohne Fehler abgearbeitet hat. */
    public static final String ERLEDIGT = "erledigt";

    /** Ein Kundenbereich, an dem ein Bestands-Läufer gescheitert ist — die Regel feuert ab 1. */
    public static final String GESCHEITERT = "fehler";

    // Die Label-Werte. Sie sind der VERTRAG mit den Alarm-Regeln des gitops-Repos (IP-10) und stehen
    // deshalb als Konstanten hier, nicht als Zeichenkette an der Rufstelle.

    /** {@code ViertelstundeLaeufer}. */
    public static final String VIERTELSTUNDE = "viertelstunde";
    /** {@code EndgueltigkeitLaeufer} — Stundenlauf, Tageslauf, Perioden, Kennzahlen. */
    public static final String ENDGUELTIGKEIT = "endgueltigkeit";
    /** {@code LueckenLaeufer}. Der Wortlaut hängt an der Regel {@code VoltPilotLueckenMelderSteht}. */
    public static final String LUECKEN = "luecken";
    /** {@code ErsatzwertLaeufer}. */
    public static final String ERSATZWERT = "ersatzwert";
    /** {@code KorrekturKaskadeLaeufer}. */
    public static final String KASKADE = "kaskade";
    /** {@code StrukturAenderungLaeufer}. */
    public static final String BERICHT_STRUKTUR = "bericht_struktur";
    /** {@code ZeilentextAufbewahrungLaeufer}. */
    public static final String ZEILENTEXTE = "zeilentexte";
    /** {@code PlanZustellungAufbewahrungLaeufer} — Frist der Plan-Zustellungen (AP-15 IP-11). */
    public static final String PLAN_ZUSTELLUNG = "plan_zustellung";
    /** {@code LadeparkGrenzeLaeufer} — Grenzblatt-Anstoß (AP-15 IP-3, Paket {@code chargers}). */
    public static final String LADEPARK_GRENZE = "ladepark_grenze";
    /** {@code UebergabeLaeufer}. */
    public static final String UEBERGABE = "uebergabe";
    /** {@code BoxTauschZustellung}. */
    public static final String BOX_TAUSCH = "box_tausch";
    /** {@code AblaufLaeufer} der Unterstützung. */
    public static final String UNTERSTUETZUNG = "unterstuetzung";
    /** {@code BestandsuebernahmeLaeufer} — Start-Läufer der Standorte. */
    public static final String BESTAND_STANDORT = "bestand_standort";
    /** {@code FunktionBestandLaeufer} — Start-Läufer der Funktionen. */
    public static final String BESTAND_FUNKTION = "bestand_funktion";
    /** {@code ZugriffBestandLaeufer} — Start-Läufer der Rechte. */
    public static final String BESTAND_RECHTE = "bestand_rechte";

    /**
     * Ein Läufer des Katalogs.
     *
     * @param label   der Label-Wert im Export — der Vertrag mit den Alarm-Regeln
     * @param klasse  der einfache Klassenname; {@code UemsLaeuferKatalogTest} hält damit Katalog und
     *                Code zusammen, damit ein künftiger Läufer nicht still unbeobachtet bleibt
     * @param schalter ALLE Eigenschaften, die diesen Läufer abschalten — ist eine davon {@code false},
     *                ist er aus (der Struktur-Läufer hängt an zweien)
     * @param takt    der Takt in Worten, für die Doku und die Schwelle „kein Lauf &gt; 3 × Takt“
     */
    public record Eintrag(String label, String klasse, List<String> schalter, String takt) {}

    /**
     * ALLE geplanten UEMS-Läufer — fünfzehn, in der Reihenfolge der Verarbeitungskette, danach die
     * drei Start-Läufer. Wer einen Läufer ergänzt, ergänzt ihn hier; sonst ist er unbeobachtet.
     */
    public static final List<Eintrag> KATALOG = List.of(
            new Eintrag(VIERTELSTUNDE, "ViertelstundeLaeufer",
                    List.of("voltpilot.uems.viertelstunde.enabled"), "5 min"),
            new Eintrag(ENDGUELTIGKEIT, "EndgueltigkeitLaeufer",
                    List.of("voltpilot.uems.endgueltigkeit.enabled"), "1 h"),
            new Eintrag(LUECKEN, "LueckenLaeufer",
                    List.of("voltpilot.uems.luecken.enabled"), "5 min"),
            new Eintrag(ERSATZWERT, "ErsatzwertLaeufer",
                    List.of("voltpilot.uems.ersatzwert.enabled"), "5 min"),
            new Eintrag(KASKADE, "KorrekturKaskadeLaeufer",
                    List.of("voltpilot.uems.kaskade.enabled"), "5 min"),
            new Eintrag(BERICHT_STRUKTUR, "StrukturAenderungLaeufer",
                    List.of("voltpilot.uems.berichte.struktur.enabled", "voltpilot.uems.berichte.enabled"),
                    "5 min"),
            new Eintrag(ZEILENTEXTE, "ZeilentextAufbewahrungLaeufer",
                    List.of("voltpilot.uems.zeilentexte.enabled"), "taeglich 03:17 Europe/Berlin"),
            new Eintrag(PLAN_ZUSTELLUNG, "PlanZustellungAufbewahrungLaeufer",
                    List.of("voltpilot.uems.plan-zustellung.enabled"), "taeglich 03:47 Europe/Berlin"),
            new Eintrag(LADEPARK_GRENZE, "LadeparkGrenzeLaeufer",
                    List.of("voltpilot.uems.ladepark-grenze.enabled"), "1 h (Minute 1, UTC)"),
            new Eintrag(UEBERGABE, "UebergabeLaeufer",
                    List.of("voltpilot.uems.uebergabe.enabled"), "1 s"),
            new Eintrag(BOX_TAUSCH, "BoxTauschZustellung",
                    List.of("voltpilot.uems.uebergabe.enabled"), "15 s"),
            new Eintrag(UNTERSTUETZUNG, "AblaufLaeufer",
                    List.of("voltpilot.uems.unterstuetzung.enabled"), "1 min"),
            new Eintrag(BESTAND_STANDORT, "BestandsuebernahmeLaeufer",
                    List.of("voltpilot.uems.bestandsuebernahme.enabled"), "Start"),
            new Eintrag(BESTAND_FUNKTION, "FunktionBestandLaeufer",
                    List.of("voltpilot.uems.funktion-bestand.enabled"), "Start"),
            new Eintrag(BESTAND_RECHTE, "ZugriffBestandLaeufer",
                    List.of("voltpilot.uems.zugriff-bestand.enabled"), "Start"));

    /** Die drei Start-Läufer der Schicht „Übernahme“ — sie allein zählen je Ergebnis. */
    public static final List<String> BESTANDS_LAEUFER =
            List.of(BESTAND_STANDORT, BESTAND_FUNKTION, BESTAND_RECHTE);

    /**
     * Ein Melder ohne Bindung an die Anwendungs-Registry: die Vorgabe jedes Läufer-Feldes, damit ein
     * direkt gebauter Läufer meldet, ohne dass ein bestehender Konstruktor sich ändert.
     */
    public static final UemsLaeuferMelder STUMM = new UemsLaeuferMelder(new SimpleMeterRegistry());

    private final Map<String, Counter> fehler = new LinkedHashMap<>();
    private final Map<String, Instant> letzterLauf = new ConcurrentHashMap<>();
    private final MeterRegistry registry;
    private volatile Clock uhr = Clock.systemUTC();

    public UemsLaeuferMelder(MeterRegistry registry) {
        this.registry = registry;
        for (Eintrag e : KATALOG) {
            // Von Anfang an registriert und auf 0: eine Regel `increase(...) > 0` braucht die Reihe,
            // bevor der erste Fehler auftritt - sonst faende sie nach einem Neustart nichts vor.
            fehler.put(e.label(), Counter.builder(FEHLER).tag("laeufer", e.label())
                    .description("Gescheiterte Laeufe seit dem Start dieses Prozesses")
                    .register(registry));
        }
    }

    /** Nur für Tests: die Uhr, an der „zuletzt gelaufen“ hängt. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /** Der Läufer hat einen Lauf beendet. Wirft nie. */
    public void gelaufen(String laeufer) {
        try {
            letzterLauf.put(laeufer, uhr.instant());
        } catch (RuntimeException e) {
            log.debug("UEMS-Laeufermeldung {} verworfen: {}", laeufer, e.toString());
        }
    }

    /** Der Lauf ist gescheitert. Zählt und lässt „zuletzt gelaufen“ stehen. Wirft nie. */
    public void fehler(String laeufer) {
        try {
            Counter c = fehler.get(laeufer);
            if (c == null) {
                log.debug("UEMS-Laeufer {} steht nicht im Katalog", laeufer);
                return;
            }
            c.increment();
        } catch (RuntimeException e) {
            log.debug("UEMS-Fehlermeldung {} verworfen: {}", laeufer, e.toString());
        }
    }

    /**
     * Ein Bestands-Läufer hat seinen Lauf beendet: {@code kundenbereiche} betrachtet, davon
     * {@code fehler} gescheitert. Meldet zugleich „gelaufen“. Wirft nie.
     */
    public void bestandGelaufen(String laeufer, int kundenbereiche, int gescheitert) {
        try {
            zaehle(laeufer, ERLEDIGT, Math.max(0, kundenbereiche - gescheitert));
            zaehle(laeufer, GESCHEITERT, Math.max(0, gescheitert));
            gelaufen(laeufer);
        } catch (RuntimeException e) {
            log.debug("UEMS-Bestandsmeldung {} verworfen: {}", laeufer, e.toString());
        }
    }

    private void zaehle(String laeufer, String ergebnis, int anzahl) {
        if (anzahl <= 0) {
            // Die Reihe trotzdem anlegen: eine fehlende Reihe ist fuer eine Regel nicht dasselbe wie 0.
            Counter.builder(BESTAND).tag("laeufer", laeufer).tag("ergebnis", ergebnis)
                    .description("Kundenbereiche je Ergebnis des Start-Laufs").register(registry);
            return;
        }
        Counter.builder(BESTAND).tag("laeufer", laeufer).tag("ergebnis", ergebnis)
                .description("Kundenbereiche je Ergebnis des Start-Laufs").register(registry)
                .increment(anzahl);
    }

    /** Wann dieser Läufer zuletzt fertig geworden ist; leer = seit dem Start dieses Prozesses nie. */
    public Optional<Instant> letzterLauf(String laeufer) {
        return Optional.ofNullable(letzterLauf.get(laeufer));
    }
}
