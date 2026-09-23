package com.voltpilot.api.uems;

import static com.voltpilot.api.uems.EreignisVokabular.Achse.EINGANGSZEIT;
import static com.voltpilot.api.uems.EreignisVokabular.Achse.MESSZEIT;
import static com.voltpilot.api.uems.EreignisVokabular.Grenzen.GESCHLOSSEN;
import static com.voltpilot.api.uems.EreignisVokabular.Grenzen.HALBOFFEN;
import static com.voltpilot.api.uems.EreignisVokabular.Urheber.BOX;
import static com.voltpilot.api.uems.EreignisVokabular.Urheber.CLOUD;
import static com.voltpilot.api.uems.EreignisVokabular.Urheber.DATENANNAHME;
import static com.voltpilot.api.uems.EreignisVokabular.Urheber.KUNDE;
import static com.voltpilot.api.uems.EreignisVokabular.Urheber.WRITER;
import static com.voltpilot.api.uems.EreignisVokabular.Zeitform.ZEITPUNKT;
import static com.voltpilot.api.uems.EreignisVokabular.Zeitform.ZEITRAUM;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.EnumSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Das geschlossene EREIGNIS-VOKABULAR und seine reine Prüfung (UEMS AP-07 IP-3, Entscheid E11:
 * EIN Ereignis-Vertrag für beide Pfade, nie gelöscht; Prosa in
 * {@code docs/contracts/v2/events-vocabulary.md}).
 *
 * <p>Je Art steht fest, wer sie melden darf (Box · Datenannahme · Writer · Cloud · Kunde),
 * worauf sie sich bezieht (Box, Datenquelle, Reihe, Messstelle), welche Zeitform sie hat
 * (Zeitpunkt oder Zeitraum, halboffen oder geschlossen, offen erlaubt oder nicht, auf der Achse
 * Messzeit oder Eingangszeit), welche Felder sie trägt und welche davon eine Fortschreibung
 * setzen darf. Die Prüfung macht daraus GENAU EIN Urteil: angenommen, oder verworfen mit einem
 * Grund aus demselben geschlossenen Vokabular, das {@code rejected} trägt.
 *
 * <p>Ohne Spring, ohne Repository, ohne Uhr (das {@link ZustandAbleitung}-Muster). Die Schwellen
 * der Zeit-Ereignisse kommen aus {@link MesswertHerkunft} — gerufen, nicht nachgebaut. Die
 * Vektoren {@code docs/contracts/v2/events-vocabulary-vectors.json} pinnen Vokabular und Urteile;
 * der TS-Zwilling {@code frontend/portal/src/uemsEreignis.ts} spricht den Kundensatz aus
 * derselben Datei. <b>Wer eine Art, ein Feld oder eine Regel ändert, ändert diese Klasse, den
 * Zwilling, beide Schemas und die Vektor-Datei — und seit IP-8 auch den Writer-Zwilling
 * ({@code services/timescale-writer/.../EreignisVokabular.java}) und das Vokabular der Tabelle
 * ({@code messreihe_ereignis_vokabular()}, mit einer neuen Migration).</b>
 *
 * <h2>Wer anruft</h2>
 *
 * Die Ereignis-Tabelle {@code messreihe_ereignis} (IP-8) hängt an, was diese Klasse annimmt:
 * in der api über {@link MessreiheEreignisRepository}, im Writer über seinen Zwilling, der
 * {@code events.raw} liest. Keine Box sendet Ereignisse (erst mit einem Edge-Release), die
 * Datenannahme verarbeitet {@code …/v2/events} noch nicht (IP-5); der Writer schreibt
 * {@code device_measurement_event} unverändert weiter und spiegelt jedes Ereignis davon.
 *
 * <h2>Die Reihenfolge der Prüfungen</h2>
 *
 * <ol>
 *   <li><b>Umschlag</b> (nur {@link #pruefeUmschlag}): Fassung {@code 2.1} → Form → Kennung
 *       (Topic ⟷ Umschlag byte-gleich) → jedes Ereignis wie unten, mit {@code box} aus dem
 *       Topic. Der Umschlag ist die Einheit: das erste verworfene Ereignis verwirft ihn ganz.
 *   <li><b>Art</b> bekannt, sonst {@code wort_unbekannt} — nie auf eine ähnliche geraten.
 *   <li><b>Urheber</b> darf die Art melden, sonst {@code urheber_unzulaessig}.
 *   <li><b>Felder:</b> alle Pflichtfelder da, kein fremdes Feld, jeder Wert von seinem Typ, sonst
 *       {@code schema_verletzt}. Eine Box sendet genau ihre Felder plus {@code box} aus dem
 *       Topic.
 *   <li><b>Wörter</b> der Teil-Vokabulare bekannt, sonst {@code wort_unbekannt}.
 *   <li><b>Zeit:</b> Ende nach Beginn (halboffen) bzw. nicht davor (geschlossen), offen nur, wo
 *       die Art es erlaubt und nie von der Box, volle Minute bzw. Viertelstunden-Raster, wo die Art
 *       es verlangt, sonst {@code zeit_ungueltig}.
 *   <li><b>Regeln der Art</b> (Anzahl aus den Sequenzen, Einbau je Anlass, Ursache nur mit
 *       exportiertem Fakt, …), sonst {@code regel_verletzt}.
 * </ol>
 *
 * <p>Eine <b>Fortschreibung</b> ({@link #pruefeFortschreibung}) trägt dieselbe
 * {@code ereignis_id}; sie darf nur ein leeres fortschreibbares Feld setzen — nie einen Beginn
 * verschieben, ein gesetztes Ende ändern oder ein Feld entfernen ({@code
 * fortschreibung_unzulaessig}). So bleibt der Speicher append-only.
 */
public final class EreignisVokabular {

    /** Die Fassung des Umschlags Box → Cloud ({@code mqtt-events-2.1.schema.json}). */
    public static final String FASSUNG_UMSCHLAG = "2.1";

    /** Höchstens so viele Ereignisse trägt ein Umschlag. */
    public static final int EREIGNISSE_JE_UMSCHLAG_HOECHSTENS = 64;

    /** Das Viertelstunden-Raster (UTC) eines Viertelstundenwerts. */
    public static final long VIERTELSTUNDE_S = 900L;

    private EreignisVokabular() {}

    // ------------------------------------------------------------------ Vokabular

    /** Wer ein Ereignis melden darf. */
    public enum Urheber {
        BOX("box"),
        DATENANNAHME("datenannahme"),
        WRITER("writer"),
        CLOUD("cloud"),
        KUNDE("kunde");

        private final String code;

        Urheber(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }

        public static Urheber vonCode(String code) {
            for (Urheber u : values()) {
                if (u.code.equals(code)) {
                    return u;
                }
            }
            return null;
        }
    }

    /** Warum ein Ereignis verworfen wird — dasselbe Vokabular trägt {@code rejected.grund}. */
    public enum Grund {
        HERKUNFT_UNVOLLSTAENDIG("herkunft_unvollstaendig"),
        FASSUNG_UNBEKANNT("fassung_unbekannt"),
        KENNUNG_ABWEICHEND("kennung_abweichend"),
        SCHEMA_VERLETZT("schema_verletzt"),
        WORT_UNBEKANNT("wort_unbekannt"),
        URHEBER_UNZULAESSIG("urheber_unzulaessig"),
        ZEIT_UNGUELTIG("zeit_ungueltig"),
        REGEL_VERLETZT("regel_verletzt"),
        FORTSCHREIBUNG_UNZULAESSIG("fortschreibung_unzulaessig");

        private final String code;

        Grund(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }

        public static Grund vonCode(String code) {
            for (Grund g : values()) {
                if (g.code.equals(code)) {
                    return g;
                }
            }
            return null;
        }
    }

    public enum Zeitform {
        ZEITPUNKT,
        ZEITRAUM
    }

    /** Halboffen = [von, bis); geschlossen = [von, bis], beide enthalten. */
    public enum Grenzen {
        HALBOFFEN,
        GESCHLOSSEN
    }

    /** Auf welcher Uhr die Zeitangaben einer Art liegen (E13 Nr. 2). */
    public enum Achse {
        MESSZEIT,
        EINGANGSZEIT
    }

    /** Der Typ eines Felds. */
    public enum Typ {
        UUID,
        WORT,
        ZEIT,
        ZEIT_ODER_LEER,
        KENNUNG,
        TEXT,
        GANZ_AB_0,
        GANZ_AB_1,
        SEKUNDEN,
        STATUSWORT,
        STAND,
        MESSWERT,
        GANZ_LISTE,
        WORT_LISTE,
        WERT
    }

    /** Jedes Feld, das eine Art tragen darf, mit seinem Typ. */
    public static final Map<String, Typ> FELDER;

    static {
        Map<String, Typ> f = new LinkedHashMap<>();
        f.put("ereignis_id", Typ.UUID);
        f.put("art", Typ.WORT);
        f.put("zeitpunkt", Typ.ZEIT);
        f.put("von", Typ.ZEIT);
        f.put("bis", Typ.ZEIT_ODER_LEER);
        for (String k : List.of("box", "box_alt", "box_neu", "zustaendige_box", "datenquelle",
                "komponente")) {
            f.put(k, Typ.KENNUNG);
        }
        f.put("messkanal", Typ.TEXT);
        f.put("messstelle", Typ.KENNUNG);
        f.put("einbau_alt", Typ.KENNUNG);
        f.put("einbau_neu", Typ.KENNUNG);
        f.put("erkannt_aus", Typ.WORT);
        f.put("erwartet_fehlend", Typ.GANZ_AB_0);
        f.put("nachgeliefert_am", Typ.ZEIT_ODER_LEER);
        f.put("fehlerklasse", Typ.WORT);
        f.put("ursache_ereignis", Typ.UUID);
        f.put("eingang_von", Typ.ZEIT);
        f.put("eingang_bis", Typ.ZEIT);
        f.put("anzahl", Typ.GANZ_AB_1);
        f.put("erwartet", Typ.GANZ_AB_1);
        f.put("messzeit", Typ.ZEIT);
        f.put("gespeicherter_wert", Typ.MESSWERT);
        f.put("abgewiesener_wert", Typ.MESSWERT);
        f.put("sequenzen", Typ.GANZ_LISTE);
        f.put("einheit", Typ.TEXT);
        f.put("strom", Typ.WORT);
        f.put("sequenz", Typ.GANZ_AB_0);
        f.put("sequenz_erwartet", Typ.GANZ_AB_0);
        f.put("sequenz_erhalten", Typ.GANZ_AB_0);
        f.put("eingangszeit", Typ.ZEIT);
        f.put("stand_alt", Typ.STAND);
        f.put("stand_neu", Typ.STAND);
        f.put("messzeit_alt", Typ.ZEIT);
        f.put("wertebereich_modul", Typ.STAND);
        f.put("hoechstzuwachs_je_kadenz", Typ.STAND);
        f.put("kadenz_s", Typ.SEKUNDEN);
        f.put("anlass", Typ.WORT);
        f.put("eingetragen_am", Typ.ZEIT);
        f.put("endstand", Typ.STAND);
        f.put("anfangsstand", Typ.STAND);
        f.put("bestaetigt_ereignis", Typ.UUID);
        f.put("grund", Typ.WORT);
        f.put("vor_s", Typ.SEKUNDEN);
        f.put("alter_s", Typ.SEKUNDEN);
        f.put("sprung_s", Typ.SEKUNDEN);
        f.put("herzschlag_vorher", Typ.GANZ_AB_0);
        f.put("herzschlag_nachher", Typ.GANZ_AB_0);
        f.put("lesungen", Typ.GANZ_AB_1);
        f.put("herzschlag", Typ.GANZ_AB_0);
        f.put("statuswort", Typ.STATUSWORT);
        f.put("fassung_erwartet", Typ.GANZ_AB_1);
        f.put("fassung_gelesen", Typ.GANZ_AB_1);
        f.put("karten_erwartet", Typ.GANZ_AB_0);
        f.put("karten_gelesen", Typ.GANZ_AB_0);
        f.put("alt", Typ.WERT);
        f.put("neu", Typ.WERT);
        // AP-08 IP-6 (additiv): der gemessene Zuwachs über eine Lücke.
        f.put("zuwachs", Typ.STAND);
        f.put("stand_vor", Typ.STAND);
        f.put("stand_nach", Typ.STAND);
        // AP-08 IP-12 (additiv): Ersatzwert und Korrektur.
        f.put("ersatzwert", Typ.KENNUNG);
        f.put("methode", Typ.WORT);
        f.put("status", Typ.WORT);
        f.put("korrektur", Typ.KENNUNG);
        f.put("korrektur_art", Typ.WORT);
        // AP-09 IP-7 (additiv): die Berichtigung eines Bezugsgrößen-Werts — Bezug, Fassungen, Import.
        f.put("bezugsgroesse", Typ.KENNUNG);
        f.put("fassung_alt", Typ.GANZ_AB_1);
        f.put("fassung_neu", Typ.GANZ_AB_1);
        f.put("import", Typ.KENNUNG);
        // AP-10 IP-11 (additiv): was eine Neuberechnung der Bilanz auslöste (K-… oder EW-…).
        f.put("ausloeser", Typ.KENNUNG);
        // AP-12 IP-4 (additiv): die Berichts-Ereignisse — Bericht, Stand, Datenstand, Prüfsumme, Anstoß, Ausgabe.
        f.put("bericht", Typ.KENNUNG);
        f.put("nr", Typ.GANZ_AB_1);
        f.put("datenstand", Typ.ZEIT);
        f.put("pruefsumme", Typ.KENNUNG);
        f.put("anstoss_art", Typ.WORT);
        f.put("anlass_kennung", Typ.KENNUNG);
        f.put("anlass_fassung", Typ.GANZ_AB_1);
        f.put("format", Typ.WORT);
        // AP-11 IP-8 (additiv): die neu gebildete Kennzahl — ihr Kennzeichen (KZ-…) als Bezug und die Version n + 1.
        f.put("kennzahl", Typ.KENNUNG);
        f.put("version", Typ.GANZ_AB_1);
        f.put("energieeinsatz", Typ.KENNUNG);
        f.put("fassung", Typ.GANZ_AB_1);
        f.put("einstufung", Typ.WORT);
        f.put("gruende", Typ.WORT_LISTE);
        // AP-16 IP-19: der Messbedarf ist der Bezug der beiden Kundenereignisse.
        f.put("messbedarf", Typ.KENNUNG);
        FELDER = Collections.unmodifiableMap(f);
    }

    /** Die Uplinks einer Box — das Blatt des Topics unter {@code …/v2/}. */
    public static final List<String> STROM = List.of("telemetry", "measurement-samples", "events");

    /** Woraus eine Lücke erkannt wurde, und wer das kann. */
    public static final Map<String, Urheber> ERKANNT_AUS;

    static {
        Map<String, Urheber> e = new LinkedHashMap<>();
        e.put("kadenz", WRITER);
        e.put("verdraengung", BOX);
        e.put("herzschlag", CLOUD);
        ERKANNT_AUS = Collections.unmodifiableMap(e);
    }

    /**
     * Wer dasselbe ZUSÄTZLICH feststellen darf (additiv, Vektor-Datei {@code auch_urheber}): die
     * Kadenz-Lücke auch der Lücken-Melder der api ({@code cloud}, AP-07 IP-9) — wie
     * {@code late_arrival} seit IP-13. {@code verdraengung} bleibt der Box, {@code herzschlag} der
     * Cloud.
     */
    public static final Map<String, Set<Urheber>> ERKANNT_AUS_AUCH =
            Map.of("kadenz", Collections.unmodifiableSet(EnumSet.of(CLOUD)));

    public static final List<String> ANLASS_GERAETEGRENZE =
            List.of("zaehlerwechsel", "kartenwechsel", "controllerwechsel", "zaehler_zurueckgesetzt");

    /** Die Anlässe einer Gerätegrenze, bei denen das Gerät bleibt (AP-05 E6). */
    public static final Set<String> GRENZE_OHNE_GERAETEWECHSEL =
            Set.of("kartenwechsel", "zaehler_zurueckgesetzt");

    public static final List<String> ANLASS_UEBERGABE = List.of("uebergabe", "box_tausch");

    public static final List<String> QUALITAET =
            List.of("good", "uncertain", "invalid", "stale", "device_error");

    /**
     * AP-08 IP-6 — die Einheiten, in denen {@code data_gap} einen Zuwachs trägt: die Einheiten der
     * Größen mit Wertart Zählerstand im Größen-Katalog der Messstellen, jeweils mit ihren
     * umrechenbaren Einheiten — gerufen aus {@link MessstelleRegeln}, nicht nachgebaut
     * ({@code vokabular.einheit_zuwachs}). Kein freier Text: ein Zuwachs in „Impulse“ ist erst mit
     * einer Größe dafür eine Menge.
     */
    public static final List<String> EINHEITEN_ZUWACHS = MessstelleRegeln.GROESSEN_KATALOG.stream()
            .filter(k -> k.wertarten().contains("Zählerstand"))
            .flatMap(k -> MessstelleRegeln.KANAL_EINHEITEN.getOrDefault(k.groesse(), List.of(k.einheit())).stream())
            .distinct()
            .toList();

    /** AP-08 IP-6 — die Felder des Zuwachses über eine Lücke; sie stehen nur zusammen. */
    public static final List<String> ZUWACHS_FELDER = List.of("zuwachs", "einheit", "stand_vor", "stand_nach");

    /**
     * AP-08 IP-12 — die sieben Methoden eines Ersatzwerts (E7, a–g in dieser Reihenfolge;
     * {@code vokabular.ersatzwert_methode}). Welche davon einen gemessenen Zuwachs verteilen und
     * welche nur ohne ihn stehen dürfen, hält die Tabelle {@code messreihe_ersatzwert} über
     * {@code messreihe_korrektur_vokabular()} — die Meldung nennt nur die Methode.
     */
    public static final List<String> ERSATZWERT_METHODE = List.of("gleichmaessig_verteilen",
            "profil_vorperiode", "profil_vergleichsquelle", "ablesestand_nachtragen", "wert_eingeben",
            "vorperiode_uebernehmen", "vergleichsquelle_uebernehmen");

    /** AP-08 IP-12 — der Stand eines Ersatzwerts: nie gelöscht, nur zurückgenommen. */
    public static final List<String> ERSATZWERT_STATUS = List.of("wirksam", "zurueckgenommen");

    /**
     * AP-08 IP-12 — die Arten einer Korrektur (§4.6); die sechste, {@code menge_nachgetragen}, trägt den Nachtrag
     * der Tagesmenge an Tagen, die vor AP-08 IP-5 schon endgültig waren (V20260924013000).
     */
    public static final List<String> KORREKTUR_ART = List.of("nachlieferung_nach_endgueltigkeit",
            "ablesestaende_nachgetragen", "umklassifizierung", "ersatzwert", "wert_berichtigt", "menge_nachgetragen");

    /** AP-08 IP-12 — die Art einer Korrektur, die genau einen Ersatzwert nennt. */
    public static final String KORREKTUR_ART_ERSATZWERT = "ersatzwert";

    /** AP-08 IP-12 — der Stand einer Korrektur; der Anfang ist {@code vorschlag} (E14). */
    public static final List<String> KORREKTUR_STATUS =
            List.of("vorschlag", "freigegeben", "abgelehnt", "zurueckgenommen");

    private static final Pattern ERSATZWERT_KENNUNG = Pattern.compile("^EW-[0-9]{4}-[0-9]{4,}$");
    private static final Pattern KORREKTUR_KENNUNG = Pattern.compile("^K-[0-9]{4}-[0-9]{4,}$");
    /** AP-10 IP-11 — der Auslöser einer Neuberechnung ist eine Korrektur oder ein Ersatzwert. */
    private static final Pattern AUSLOESER_KENNUNG = Pattern.compile("^(K|EW)-[0-9]{4}-[0-9]{4,}$");
    /**
     * AP-11 IP-9 — der Auslöser einer Kennzahl-Neubildung: eine Korrektur, ein Ersatzwert, die Berichtigung eines
     * Bezugsgrößen-Werts ({@code BK-…}), eine rückwirkende Fassung der Berechnung ({@code KZ-0004/Fassung-2}) oder ein
     * rückwirkendes Stammdatum ({@code BZ-8/ab-2027-01-01}). Ein bloßes Kennzeichen ({@code MS-12}) ist keine Ursache.
     */
    private static final Pattern KENNZAHL_AUSLOESER = Pattern.compile("^(?:(?:K|EW|BK)-[0-9]{4}-[0-9]{4,}"
            + "|[A-Z0-9./-]{2,16}/Fassung-[0-9]+|[A-Z0-9./-]{2,16}/ab-[0-9]{4}-[0-9]{2}-[0-9]{2})$");
    /** AP-12 IP-4 — die Kennung eines Berichts (bericht.md §1) und die Prüfsumme eines Abzugs (A6). */
    private static final Pattern BERICHT_KENNUNG = Pattern.compile("^BR-[0-9]{4}-[0-9]{4,}$");
    private static final Pattern PRUEFSUMME = Pattern.compile("^sha256:[0-9a-f]{64}$");

    /** AP-12 IP-4 — was einen Anstoß an einen Berichtsstand auslöst (bericht-vectors.json → vokabulare.anstoss_art). */
    public static final List<String> ANSTOSS_ART = List.of("korrektur_freigegeben", "korrektur_zurueckgenommen",
            "ersatzwert_wirksam", "ersatzwert_zurueckgenommen", "bezugsgroesse_fassung", "kennzahl_fassung_rueckwirkend",
            "zuordnung_rueckwirkend", "anlage_umzug_rueckwirkend", "flaeche_rueckwirkend", "verteilung_rueckwirkend",
            "einstufung_fassung", "kriterien_fassung", "umfang_fassung", "messbedarf_zustand",
            "prozess_zuordnung_rueckwirkend", "messmittel_angabe");
    /** AP-12 IP-4 — die Ausgaben eines Berichtsstands, deren Abruf gemeldet wird (DA5). */
    public static final List<String> BERICHT_FORMAT = List.of("pdf", "csv");
    /** AP-09 IP-7 — der Vorgang einer Berichtigung eines Bezugsgrößen-Werts (bezugsgroesse_berichtigung). */
    private static final Pattern BERICHTIGUNG_KENNUNG = Pattern.compile("^BK-[0-9]{4}-[0-9]{4,}$");
    /** AP-09 IP-7 — ein Import der Bezugsdaten (C2). */
    private static final Pattern IMPORT_KENNUNG = Pattern.compile("^I-[0-9]{4}-[0-9]{4,}$");

    /** AP-09 IP-7 — die Art, mit der ein Bezugsgrößen-Wert berichtigt wird. */
    public static final String KORREKTUR_ART_BEZUGSWERT = "wert_berichtigt";

    /** AP-09 IP-7 — der Bezug einer Korrektur: die Reihe ODER die Bezugsgröße mit ihren Fassungen. */
    public static final List<String> KORREKTUR_BEZUG_REIHE = List.of("komponente", "messkanal");
    public static final List<String> KORREKTUR_BEZUG_BEZUGSGROESSE = List.of("bezugsgroesse", "fassung_alt", "fassung_neu");

    /**
     * Die Fehlerklassen je Datenquelle (AP-06 E5) — gerufen aus
     * {@link DatenquelleRegeln.Fehlerklasse}, nicht nachgebaut. Sie sind ZUSTAND (Herzschlag je
     * Quelle, IP-13); ein Ereignis trägt eine nur, wenn ein exportierter Fakt sie belegt.
     */
    public static final List<String> FEHLERKLASSEN =
            Arrays.stream(DatenquelleRegeln.Fehlerklasse.values())
                    .map(DatenquelleRegeln.Fehlerklasse::code)
                    .toList();

    public static final String BOX_MELDET_SICH_NICHT =
            DatenquelleRegeln.Fehlerklasse.BOX_MELDET_SICH_NICHT.code();

    /** Die Ereignisarten — geschlossen. */
    public enum Art {
        DATA_GAP("data_gap", EnumSet.of(WRITER, BOX, CLOUD), ZEITRAUM, HALBOFFEN, true, MESSZEIT,
                List.of(), List.of("box", "datenquelle", "komponente", "messkanal", "messstelle"),
                List.of("erkannt_aus"),
                List.of("erwartet_fehlend", "nachgeliefert_am", "fehlerklasse", "ursache_ereignis",
                        "zuwachs", "einheit", "stand_vor", "stand_nach"),
                List.of("bis", "erwartet_fehlend", "nachgeliefert_am", "ursache_ereignis",
                        "zuwachs", "einheit", "stand_vor", "stand_nach"),
                List.of("ereignis_id", "art", "von", "bis", "erkannt_aus"),
                List.of("ereignis_id", "art", "von", "bis", "erkannt_aus", "datenquelle",
                        "komponente", "messkanal", "erwartet_fehlend")),
        BACKFILL("backfill", EnumSet.of(WRITER, CLOUD), ZEITRAUM, GESCHLOSSEN, false, MESSZEIT,
                List.of("box", "datenquelle"), List.of(),
                List.of("eingang_von", "eingang_bis", "anzahl"), List.of("erwartet"), List.of(),
                null, null),
        DUPLICATE_CONFLICT("duplicate_conflict", EnumSet.of(WRITER), ZEITPUNKT, null, false,
                EINGANGSZEIT, List.of("box", "komponente", "messkanal"), List.of("messstelle"),
                List.of("messzeit", "gespeicherter_wert", "abgewiesener_wert", "sequenzen"),
                List.of("einheit"), List.of(), null, null),
        SEQUENCE_GAP("sequence_gap", EnumSet.of(WRITER), ZEITPUNKT, null, false, EINGANGSZEIT,
                List.of("box"), List.of(),
                List.of("strom", "sequenz_erwartet", "sequenz_erhalten", "anzahl"), List.of(),
                List.of(), null, null),
        SEQUENCE_RESET("sequence_reset", EnumSet.of(WRITER), ZEITPUNKT, null, false,
                EINGANGSZEIT, List.of("box"), List.of(),
                List.of("strom", "sequenz_erwartet", "sequenz_erhalten"), List.of(), List.of(),
                null, null),
        LATE_ARRIVAL("late_arrival", EnumSet.of(WRITER, CLOUD), ZEITRAUM, HALBOFFEN, false, MESSZEIT,
                List.of("komponente", "messkanal"), List.of("box", "messstelle"),
                List.of("eingangszeit", "anzahl"), List.of(), List.of(), null, null),
        COUNTER_RESET("counter_reset", EnumSet.of(WRITER), ZEITPUNKT, null, false, MESSZEIT,
                List.of("komponente", "messkanal"), List.of("box", "messstelle"),
                List.of("stand_alt", "stand_neu"), List.of("messzeit_alt", "einheit"), List.of(),
                null, null),
        COUNTER_OVERFLOW("counter_overflow", EnumSet.of(WRITER), ZEITPUNKT, null, false, MESSZEIT,
                List.of("komponente", "messkanal"), List.of("box", "messstelle"),
                List.of("stand_alt", "stand_neu", "messzeit_alt", "wertebereich_modul",
                        "hoechstzuwachs_je_kadenz", "kadenz_s"),
                List.of("einheit"), List.of(), null, null),
        DEVICE_BOUNDARY("device_boundary", EnumSet.of(KUNDE), ZEITPUNKT, null, false, MESSZEIT,
                List.of("komponente"), List.of("messkanal", "messstelle"),
                List.of("anlass", "einbau_alt", "einbau_neu", "eingetragen_am"),
                List.of("endstand", "anfangsstand", "einheit", "bestaetigt_ereignis"), List.of(),
                null, null),
        HANDOVER("handover", EnumSet.of(CLOUD), ZEITRAUM, HALBOFFEN, true, MESSZEIT,
                List.of("datenquelle"), List.of(), List.of("anlass", "box_alt", "box_neu"),
                List.of(), List.of("bis"), null, null),
        UNASSIGNED_READER("unassigned_reader", EnumSet.of(WRITER), ZEITRAUM, GESCHLOSSEN, false,
                MESSZEIT, List.of("box", "datenquelle", "komponente"), List.of("messkanal"),
                List.of("anzahl"), List.of("zustaendige_box"), List.of(), null, null),
        REJECTED("rejected", EnumSet.of(DATENANNAHME, WRITER), ZEITPUNKT, null, false,
                EINGANGSZEIT, List.of("box"), List.of(), List.of("strom", "grund"),
                List.of("anzahl", "sequenz"), List.of(), null, null),
        CLOCK_AHEAD("clock_ahead", EnumSet.of(DATENANNAHME), ZEITPUNKT, null, false,
                EINGANGSZEIT, List.of("box"), List.of(), List.of("strom", "vor_s"),
                List.of("anzahl", "sequenz"), List.of(), null, null),
        TOO_OLD("too_old", EnumSet.of(DATENANNAHME), ZEITPUNKT, null, false, EINGANGSZEIT,
                List.of("box"), List.of(), List.of("strom", "alter_s"),
                List.of("anzahl", "sequenz"), List.of(), null, null),
        CLOCK_JUMP("clock_jump", EnumSet.of(DATENANNAHME), ZEITPUNKT, null, false, EINGANGSZEIT,
                List.of("box"), List.of(), List.of("strom", "sequenz", "sprung_s"), List.of(),
                List.of(), null, null),
        BOX_RESTART("box_restart", EnumSet.of(BOX), ZEITPUNKT, null, false, MESSZEIT,
                List.of("box"), List.of(), List.of(), List.of(), List.of(),
                List.of("ereignis_id", "art", "zeitpunkt"),
                List.of("ereignis_id", "art", "zeitpunkt")),
        DEVICE_RESTART("device_restart", EnumSet.of(BOX), ZEITPUNKT, null, false, MESSZEIT,
                List.of("box", "datenquelle"), List.of(), List.of(),
                List.of("herzschlag_vorher", "herzschlag_nachher"), List.of(),
                List.of("ereignis_id", "art", "zeitpunkt", "datenquelle"),
                List.of("ereignis_id", "art", "zeitpunkt", "datenquelle", "herzschlag_vorher",
                        "herzschlag_nachher")),
        FROZEN_SOURCE("frozen_source", EnumSet.of(BOX, WRITER), ZEITPUNKT, null, false, MESSZEIT,
                List.of("box", "datenquelle"), List.of("komponente", "messkanal"), List.of(),
                List.of("lesungen", "herzschlag"), List.of(),
                List.of("ereignis_id", "art", "zeitpunkt", "datenquelle"),
                List.of("ereignis_id", "art", "zeitpunkt", "datenquelle", "komponente",
                        "messkanal", "lesungen", "herzschlag")),
        RANGE_LIMIT("range_limit", EnumSet.of(BOX), ZEITPUNKT, null, false, MESSZEIT,
                List.of("box", "datenquelle"), List.of("komponente"), List.of(),
                List.of("statuswort"), List.of(),
                List.of("ereignis_id", "art", "zeitpunkt", "datenquelle"),
                List.of("ereignis_id", "art", "zeitpunkt", "datenquelle", "komponente",
                        "statuswort")),
        LAYOUT_CHANGED("layout_changed", EnumSet.of(BOX), ZEITPUNKT, null, false, MESSZEIT,
                List.of("box", "datenquelle"), List.of(), List.of(),
                List.of("fassung_erwartet", "fassung_gelesen", "karten_erwartet",
                        "karten_gelesen"),
                List.of(), List.of("ereignis_id", "art", "zeitpunkt", "datenquelle"),
                List.of("ereignis_id", "art", "zeitpunkt", "datenquelle", "fassung_erwartet",
                        "fassung_gelesen", "karten_erwartet", "karten_gelesen")),
        ERROR_CHANGE("error_change"),
        STATE_CHANGE("state_change"),
        BITFIELD_CHANGE("bitfield_change"),
        TEXT_CHANGE("text_change"),
        // AP-08 IP-12 (additiv): der Ersatzwert und die Korrektur — nur aus der Cloud, je
        // Statuswechsel eine neue Meldung, nie fortgeschrieben.
        SUBSTITUTE("substitute", EnumSet.of(KUNDE), ZEITRAUM, HALBOFFEN, false, MESSZEIT,
                List.of("komponente", "messkanal"), List.of("messstelle"),
                List.of("ersatzwert", "methode", "status"), List.of(), List.of(), null, null),
        // AP-09 IP-7 (additiv): GENAU EIN Bezug — die Reihe (komponente + messkanal) oder die Bezugsgröße
        // mit fassung_alt/fassung_neu (optional import). Die Listen nennen keinen als Pflicht; das
        // Entweder-oder prüfen pruefeFelder (was fehlt) und pruefeRegeln (nicht beides).
        CORRECTION("correction", EnumSet.of(CLOUD, KUNDE), ZEITRAUM, HALBOFFEN, false, MESSZEIT,
                List.of(), List.of("komponente", "messkanal", "messstelle", "bezugsgroesse"),
                List.of("korrektur", "korrektur_art", "status"),
                List.of("ersatzwert", "fassung_alt", "fassung_neu", "import"), List.of(),
                null, null),
        // AP-10 IP-8 (additiv): die Verteilung einer Messstelle auf Kostenstellen hat sich ab einem
        // Tag geändert — Bezug NUR die Messstelle (eine Verteilung hängt an keiner Reihe), nur aus
        // der Cloud von einem Menschen.
        VERTEILUNG_GEAENDERT("verteilung_geaendert", EnumSet.of(KUNDE), ZEITPUNKT, null, false, MESSZEIT,
                List.of("messstelle"), List.of(), List.of("eingetragen_am"), List.of(), List.of(), null,
                null),
        // AP-10 IP-11 (additiv): die Korrektur-Kaskade hat die Bilanz-Werte einer Messstelle — ihre berechneten
        // Versionen oder ihre verteilten Werte — für einen Zeitraum neu berechnet. Bezug NUR die Messstelle, nur die
        // Cloud (gerechnet hat das System; entschieden hat ein Mensch, und das meldet `correction`).
        BILANZ_NEU_BERECHNET("bilanz_neu_berechnet", EnumSet.of(CLOUD), ZEITRAUM, HALBOFFEN, false, MESSZEIT,
                List.of("messstelle"), List.of(), List.of("ausloeser"), List.of(), List.of(), null, null),
        // AP-12 IP-4 (additiv): die vier Berichts-Ereignisse — Zeitpunkt, Bezug NUR der Bericht (BR-…). Freigabe und
        // Abruf meldet eine Person (kunde); Anstoß und Neubildung des Entwurfs erkennt das System (cloud).
        BERICHT_FREIGEGEBEN("bericht_freigegeben", EnumSet.of(KUNDE), ZEITPUNKT, null, false, MESSZEIT,
                List.of("bericht"), List.of(), List.of("nr", "datenstand", "pruefsumme"), List.of(), List.of(), null,
                null),
        BERICHT_REVISION_ANGESTOSSEN("bericht_revision_angestossen", EnumSet.of(CLOUD), ZEITPUNKT, null, false,
                MESSZEIT, List.of("bericht"), List.of(), List.of("nr", "anstoss_art", "anlass_kennung"),
                List.of("anlass_fassung"), List.of(), null, null),
        BERICHT_ENTWURF_NEU_GEBILDET("bericht_entwurf_neu_gebildet", EnumSet.of(CLOUD), ZEITPUNKT, null, false,
                MESSZEIT, List.of("bericht"), List.of(), List.of("datenstand"), List.of("anlass_kennung"), List.of(),
                null, null),
        BERICHT_ABGERUFEN("bericht_abgerufen", EnumSet.of(KUNDE), ZEITPUNKT, null, false, MESSZEIT,
                List.of("bericht"), List.of(), List.of("nr", "format"), List.of(), List.of(), null, null),
        // AP-11 IP-8 (additiv): die Korrektur-Kaskade (später auch der Nenner- und der Definitions-Auslöser, AP-11 IP-9)
        // hat einen ENDGÜLTIGEN Kennzahl-Wert als Version n + 1 neu gebildet; [von, bis) ist seine Periode. Bezug NUR die
        // Kennzahl (ihr Kennzeichen KZ-…), nur die Cloud; vorläufige Werte ziehen ohne Meldung nach.
        KENNZAHL_NEU_GEBILDET("kennzahl_neu_gebildet", EnumSet.of(CLOUD), ZEITRAUM, HALBOFFEN, false, MESSZEIT,
                List.of("kennzahl"), List.of(), List.of("ausloeser", "version"), List.of(), List.of(), null, null),
        EINSTUFUNG_GESETZT("einstufung_gesetzt", EnumSet.of(KUNDE), ZEITPUNKT, null, false, MESSZEIT,
                List.of("energieeinsatz"), List.of(), List.of("fassung", "einstufung", "gruende"),
                List.of(), List.of(), null, null),
        MESSBEDARF_ERFASST("messbedarf_erfasst", EnumSet.of(KUNDE), ZEITPUNKT, null, false, MESSZEIT,
                List.of("messbedarf"), List.of(), List.of(), List.of(), List.of(), null, null),
        MESSBEDARF_EINGELOEST("messbedarf_eingeloest", EnumSet.of(KUNDE), ZEITPUNKT, null, false, MESSZEIT,
                List.of("messbedarf", "messstelle"), List.of(), List.of(), List.of(), List.of(), null, null);

        private final String code;
        private final Set<Urheber> urheber;
        private final Zeitform zeitform;
        private final Grenzen grenzen;
        private final boolean offenErlaubt;
        private final Achse achse;
        private final List<String> bezugPflicht;
        private final List<String> bezugErlaubt;
        private final List<String> pflicht;
        private final List<String> felder;
        private final List<String> fortschreibbar;
        private final List<String> mqttPflicht;
        private final List<String> mqttFelder;

        /** Die vier Übergangs-Ereignisse des Writers (wie heute, je Reihe, alt → neu). */
        Art(String code) {
            this(code, EnumSet.of(WRITER), ZEITPUNKT, null, false, MESSZEIT,
                    List.of("komponente", "messkanal"), List.of("box", "messstelle"),
                    List.of("alt", "neu"), List.of(), List.of(), null, null);
        }

        Art(String code, Set<Urheber> urheber, Zeitform zeitform, Grenzen grenzen,
                boolean offenErlaubt, Achse achse, List<String> bezugPflicht,
                List<String> bezugErlaubt, List<String> pflicht, List<String> felder,
                List<String> fortschreibbar, List<String> mqttPflicht, List<String> mqttFelder) {
            this.code = code;
            this.urheber = Collections.unmodifiableSet(EnumSet.copyOf(urheber));
            this.zeitform = zeitform;
            this.grenzen = grenzen;
            this.offenErlaubt = offenErlaubt;
            this.achse = achse;
            this.bezugPflicht = bezugPflicht;
            this.bezugErlaubt = bezugErlaubt;
            this.pflicht = pflicht;
            this.felder = felder;
            this.fortschreibbar = fortschreibbar;
            this.mqttPflicht = mqttPflicht;
            this.mqttFelder = mqttFelder;
        }

        public String code() {
            return code;
        }

        public Set<Urheber> urheber() {
            return urheber;
        }

        public Zeitform zeitform() {
            return zeitform;
        }

        /** {@code null} bei einem Zeitpunkt. */
        public Grenzen grenzen() {
            return grenzen;
        }

        public boolean offenErlaubt() {
            return offenErlaubt;
        }

        public Achse achse() {
            return achse;
        }

        public List<String> bezugPflicht() {
            return bezugPflicht;
        }

        public List<String> bezugErlaubt() {
            return bezugErlaubt;
        }

        public List<String> pflicht() {
            return pflicht;
        }

        public List<String> felder() {
            return felder;
        }

        public List<String> fortschreibbar() {
            return fortschreibbar;
        }

        /** Meldet eine Box diese Art (über {@code …/v2/events})? */
        public boolean boxMeldet() {
            return mqttFelder != null;
        }

        /** Die Pflichtfelder, die eine Box sendet ({@code box} kommt aus dem Topic); leer, wenn nie. */
        public List<String> mqttPflicht() {
            return mqttPflicht == null ? List.of() : mqttPflicht;
        }

        /** Die Felder, die eine Box senden darf ({@code box} kommt aus dem Topic); leer, wenn nie. */
        public List<String> mqttFelder() {
            return mqttFelder == null ? List.of() : mqttFelder;
        }

        /** {@code zeitpunkt} bzw. {@code von} + {@code bis}. */
        public List<String> zeitFelder() {
            return zeitform == ZEITPUNKT ? List.of("zeitpunkt") : List.of("von", "bis");
        }

        /** Die Pflichtfelder in {@code events.raw}: Kennung, Art, Zeit, Pflicht-Bezug, Pflicht. */
        public List<String> pflichtFelder() {
            List<String> p = new ArrayList<>(List.of("ereignis_id", "art"));
            p.addAll(zeitFelder());
            p.addAll(bezugPflicht);
            p.addAll(pflicht);
            return p;
        }

        /** Alle Felder, die dieser Urheber für diese Art tragen darf. */
        public Set<String> erlaubteFelder(Urheber u) {
            Set<String> s = new LinkedHashSet<>();
            if (u == BOX) {
                s.addAll(mqttFelder());
                s.add("box");
                return s;
            }
            s.addAll(pflichtFelder());
            s.addAll(bezugErlaubt);
            s.addAll(felder);
            return s;
        }

        private List<String> pflichtFelder(Urheber u) {
            if (u != BOX) {
                return pflichtFelder();
            }
            List<String> p = new ArrayList<>(mqttPflicht());
            p.add("box");
            return p;
        }

        public static Art vonCode(String code) {
            for (Art a : values()) {
                if (a.code.equals(code)) {
                    return a;
                }
            }
            return null;
        }
    }

    // ------------------------------------------------------------------ Urteil

    /** Angenommen, oder verworfen mit Grund; {@code hinweis} sagt, woran (für Protokoll und Test). */
    public record Urteil(boolean angenommen, Grund grund, String hinweis) {
        public static final Urteil ANGENOMMEN = new Urteil(true, null, null);

        static Urteil verworfen(Grund grund, String hinweis) {
            return new Urteil(false, grund, hinweis);
        }
    }

    private static final class Verworfen extends RuntimeException {
        private final Urteil urteil;

        Verworfen(Grund grund, String hinweis) {
            super(hinweis, null, false, false);
            this.urteil = Urteil.verworfen(grund, hinweis);
        }
    }

    private static Verworfen nein(Grund grund, String hinweis) {
        return new Verworfen(grund, hinweis);
    }

    // ------------------------------------------------------------------ Prüfungen

    /** Prüft EIN Ereignis (die Form von {@code events.raw#/ereignis}) für diesen Urheber. */
    public static Urteil pruefe(JsonNode ereignis, Urheber urheber) {
        try {
            pruefeOderWirf(ereignis, urheber);
            return Urteil.ANGENOMMEN;
        } catch (Verworfen v) {
            return v.urteil;
        }
    }

    /**
     * Prüft einen Umschlag Box → Cloud gegen sein Topic. Jedes Ereignis bekommt {@code box} =
     * {@code device_id} und wird wie von {@link Urheber#BOX} gemeldet geprüft; das erste
     * verworfene verwirft den ganzen Umschlag.
     */
    public static Urteil pruefeUmschlag(String topic, JsonNode umschlag) {
        try {
            if (umschlag == null || !umschlag.isObject()) {
                throw nein(Grund.SCHEMA_VERLETZT, "kein Objekt");
            }
            JsonNode fassung = umschlag.path("schema_version");
            if (!fassung.isTextual() || !FASSUNG_UMSCHLAG.equals(fassung.asText())) {
                throw nein(Grund.FASSUNG_UNBEKANNT, "schema_version");
            }
            pruefeUmschlagForm(umschlag);
            String[] t = topic == null ? new String[0] : topic.split("/", -1);
            if (t.length != 6 || !"ems".equals(t[0]) || !"v2".equals(t[4]) || !"events".equals(t[5])
                    || !t[1].equals(umschlag.get("tenant_id").asText())
                    || !t[2].equals(umschlag.get("site_id").asText())
                    || !t[3].equals(umschlag.get("device_id").asText())) {
                throw nein(Grund.KENNUNG_ABWEICHEND, "Topic ⟷ Umschlag");
            }
            int i = 0;
            for (JsonNode e : umschlag.get("events")) {
                if (!e.isObject() || e.has("box")) {
                    throw nein(Grund.SCHEMA_VERLETZT, "events[" + i + "]");
                }
                ObjectNode mitBox = ((ObjectNode) e).deepCopy();
                mitBox.put("box", umschlag.get("device_id").asText());
                Urteil u = pruefe(mitBox, BOX);
                if (!u.angenommen()) {
                    return Urteil.verworfen(u.grund(), "events[" + i + "]: " + u.hinweis());
                }
                i++;
            }
            return Urteil.ANGENOMMEN;
        } catch (Verworfen v) {
            return v.urteil;
        }
    }

    /**
     * Prüft eine Fortschreibung: {@code neu} ist dasselbe Ereignis wie {@code alt} (dieselbe
     * {@code ereignis_id}), mit höchstens gesetzten, vorher leeren fortschreibbaren Feldern.
     */
    public static Urteil pruefeFortschreibung(JsonNode alt, JsonNode neu, Urheber urheber) {
        Urteil n = pruefe(neu, urheber);
        if (!n.angenommen()) {
            return n;
        }
        try {
            if (!pruefe(alt, urheber).angenommen()) {
                throw nein(Grund.FORTSCHREIBUNG_UNZULAESSIG, "die erste Meldung gilt nicht");
            }
            if (!alt.get("ereignis_id").equals(neu.get("ereignis_id"))
                    || !alt.get("art").equals(neu.get("art"))) {
                throw nein(Grund.FORTSCHREIBUNG_UNZULAESSIG, "anderes Ereignis");
            }
            Art art = Art.vonCode(neu.get("art").asText());
            for (Iterator<String> it = alt.fieldNames(); it.hasNext(); ) {
                String f = it.next();
                JsonNode a = alt.get(f);
                if (!neu.has(f)) {
                    throw nein(Grund.FORTSCHREIBUNG_UNZULAESSIG, f + " entfernt");
                }
                if (!gleich(a, neu.get(f)) && !(a.isNull() && art.fortschreibbar().contains(f))) {
                    throw nein(Grund.FORTSCHREIBUNG_UNZULAESSIG, f + " geändert");
                }
            }
            for (Iterator<String> it = neu.fieldNames(); it.hasNext(); ) {
                String f = it.next();
                if (!alt.has(f) && !art.fortschreibbar().contains(f)) {
                    throw nein(Grund.FORTSCHREIBUNG_UNZULAESSIG, f + " nicht fortschreibbar");
                }
            }
            return Urteil.ANGENOMMEN;
        } catch (Verworfen v) {
            return v.urteil;
        }
    }

    private static void pruefeUmschlagForm(JsonNode u) {
        Set<String> felder = Set.of("schema_version", "tenant_id", "site_id", "device_id",
                "sequence", "observed_at", "events");
        for (Iterator<String> it = u.fieldNames(); it.hasNext(); ) {
            String f = it.next();
            if (!felder.contains(f)) {
                throw nein(Grund.SCHEMA_VERLETZT, "unbekanntes Feld " + f);
            }
        }
        for (String f : List.of("tenant_id", "site_id", "device_id")) {
            if (!u.path(f).isTextual() || !UUID.matcher(u.get(f).asText()).matches()) {
                throw nein(Grund.SCHEMA_VERLETZT, f);
            }
        }
        if (!u.path("sequence").canConvertToLong() || !u.path("sequence").isIntegralNumber()
                || u.get("sequence").asLong() < 0) {
            throw nein(Grund.SCHEMA_VERLETZT, "sequence");
        }
        zeit(u, "observed_at");
        JsonNode events = u.path("events");
        if (!events.isArray() || events.isEmpty()
                || events.size() > EREIGNISSE_JE_UMSCHLAG_HOECHSTENS) {
            throw nein(Grund.SCHEMA_VERLETZT, "events");
        }
    }

    private static void pruefeOderWirf(JsonNode e, Urheber u) {
        if (e == null || !e.isObject() || u == null) {
            throw nein(Grund.SCHEMA_VERLETZT, "kein Objekt");
        }
        if (!e.path("art").isTextual()) {
            throw nein(Grund.SCHEMA_VERLETZT, "art");
        }
        Art art = Art.vonCode(e.get("art").asText());
        if (art == null) {
            throw nein(Grund.WORT_UNBEKANNT, "art " + e.get("art").asText());
        }
        if (!art.urheber().contains(u)) {
            throw nein(Grund.URHEBER_UNZULAESSIG, art.code() + " von " + u.code());
        }
        pruefeFelder(e, art, u);
        pruefeWoerter(e, art);
        pruefeZeit(e, art, u);
        pruefeRegeln(e, art, u);
    }

    private static final Pattern UUID =
            Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    private static final Pattern KENNUNG = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._:/′-]*$");
    private static final Pattern ZEIT_UTC =
            Pattern.compile("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$");

    private static void pruefeFelder(JsonNode e, Art art, Urheber u) {
        Set<String> erlaubt = art.erlaubteFelder(u);
        for (Iterator<String> it = e.fieldNames(); it.hasNext(); ) {
            String f = it.next();
            if (!erlaubt.contains(f)) {
                throw nein(Grund.SCHEMA_VERLETZT, "unbekanntes Feld " + f);
            }
        }
        for (String p : art.pflichtFelder(u)) {
            if (!e.has(p) || (e.get(p).isNull() && !"bis".equals(p))) {
                throw nein(Grund.SCHEMA_VERLETZT, "Pflichtfeld " + p);
            }
        }
        // AP-09 IP-7: eine Korrektur trifft die Reihe ODER die Bezugsgröße — was dem gewählten Bezug fehlt,
        // ist ein Pflichtfeld wie zuvor (ohne beide also weiter „Pflichtfeld komponente“).
        if (art == Art.DATA_GAP && !e.hasNonNull("box") && !(u == CLOUD
                && e.hasNonNull("messstelle") && !e.has("komponente") && !e.has("messkanal")
                && !e.has("datenquelle") && "kadenz".equals(e.path("erkannt_aus").asText()))) {
            throw nein(Grund.SCHEMA_VERLETZT, "Pflichtfeld box");
        }
        if (art == Art.CORRECTION) {
            for (String p : e.has("bezugsgroesse") ? KORREKTUR_BEZUG_BEZUGSGROESSE
                    : e.has("messstelle") && !e.has("komponente") ? List.of("messstelle") : KORREKTUR_BEZUG_REIHE) {
                if (!e.hasNonNull(p)) {
                    throw nein(Grund.SCHEMA_VERLETZT, "Pflichtfeld " + p);
                }
            }
        }
        for (Iterator<Map.Entry<String, JsonNode>> it = e.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> f = it.next();
            if (!typPasst(FELDER.get(f.getKey()), f.getValue())) {
                throw nein(Grund.SCHEMA_VERLETZT, "Typ von " + f.getKey());
            }
        }
    }

    private static boolean typPasst(Typ typ, JsonNode w) {
        return switch (typ) {
            case UUID -> w.isTextual() && UUID.matcher(w.asText()).matches();
            case WORT -> w.isTextual();
            case ZEIT -> istZeit(w);
            case ZEIT_ODER_LEER -> w.isNull() || istZeit(w);
            case KENNUNG -> w.isTextual() && w.asText().length() <= 128
                    && KENNUNG.matcher(w.asText()).matches();
            case TEXT -> w.isTextual() && !w.asText().isEmpty() && w.asText().length() <= 240;
            case GANZ_AB_0 -> ganz(w) && w.asLong() >= 0;
            case GANZ_AB_1 -> ganz(w) && w.asLong() >= 1;
            case SEKUNDEN -> ganz(w);
            case STATUSWORT -> ganz(w) && w.asLong() >= 0 && w.asLong() <= 65_535;
            case STAND -> w.isNumber();
            case MESSWERT -> istMesswert(w);
            case GANZ_LISTE -> istGanzListe(w);
            case WORT_LISTE -> istWortListe(w);
            case WERT -> w.isNull() || skalar(w);
        };
    }

    private static boolean ganz(JsonNode w) {
        return w.isIntegralNumber() && w.canConvertToLong();
    }

    private static boolean skalar(JsonNode w) {
        return w.isNumber() || w.isTextual() || w.isBoolean();
    }

    private static boolean istZeit(JsonNode w) {
        if (!w.isTextual() || !ZEIT_UTC.matcher(w.asText()).matches()) {
            return false;
        }
        try {
            Instant.parse(w.asText());
            return true;
        } catch (DateTimeParseException ex) {
            return false;
        }
    }

    /**
     * Ein Messwert trägt immer {@code raw}, {@code decoded} und {@code qualitaet}. {@code decoded}
     * ist {@code null}, wenn der Kanal keinen decodierten Wert liefert ({@code measurement-samples}
     * 2.1 lässt ihn weg, etwa ein OCPP-Protokollwert) — nie weggelassen, damit zwei gleiche Werte
     * nicht in zwei Formen ankommen, und nie 0.
     */
    private static boolean istMesswert(JsonNode w) {
        if (!w.isObject() || w.size() != 3 || !w.has("decoded")) {
            return false;
        }
        JsonNode decoded = w.get("decoded");
        return skalar(w.path("raw")) && (decoded.isNull() || skalar(decoded))
                && w.path("qualitaet").isTextual();
    }

    private static boolean istGanzListe(JsonNode w) {
        if (!w.isArray() || w.size() < 2) {
            return false;
        }
        for (JsonNode x : w) {
            if (!ganz(x) || x.asLong() < 0) {
                return false;
            }
        }
        return true;
    }

    private static boolean istWortListe(JsonNode w) {
        if (!w.isArray()) return false;
        for (JsonNode x : w) if (!x.isTextual()) return false;
        return true;
    }

    private static void pruefeWoerter(JsonNode e, Art art) {
        wort(e, "strom", STROM);
        wort(e, "erkannt_aus", List.copyOf(ERKANNT_AUS.keySet()));
        wort(e, "fehlerklasse", FEHLERKLASSEN);
        wort(e, "anlass", art == Art.DEVICE_BOUNDARY ? ANLASS_GERAETEGRENZE : ANLASS_UEBERGABE);
        wort(e, "methode", ERSATZWERT_METHODE);
        wort(e, "korrektur_art", KORREKTUR_ART);
        wort(e, "anstoss_art", ANSTOSS_ART);
        wort(e, "format", BERICHT_FORMAT);
        wort(e, "einstufung", List.of("wesentlich", "nicht_wesentlich"));
        wortListe(e, "gruende", List.of("K1", "K2", "K3", "K4"));
        wort(e, "status", art == Art.SUBSTITUTE ? ERSATZWERT_STATUS : KORREKTUR_STATUS);
        if (art == Art.DATA_GAP) {
            wort(e, "einheit", EINHEITEN_ZUWACHS);
        }
        if (e.has("grund") && Grund.vonCode(e.get("grund").asText()) == null) {
            throw nein(Grund.WORT_UNBEKANNT, "grund " + e.get("grund").asText());
        }
        for (String f : List.of("gespeicherter_wert", "abgewiesener_wert")) {
            if (e.has(f) && !QUALITAET.contains(e.get(f).get("qualitaet").asText())) {
                throw nein(Grund.WORT_UNBEKANNT, f + ".qualitaet");
            }
        }
    }

    private static void wort(JsonNode e, String feld, List<String> vokabular) {
        if (e.has(feld) && !vokabular.contains(e.get(feld).asText())) {
            throw nein(Grund.WORT_UNBEKANNT, feld + " " + e.get(feld).asText());
        }
    }

    private static void wortListe(JsonNode e, String feld, List<String> vokabular) {
        if (!e.has(feld)) return;
        for (JsonNode wert : e.get(feld)) {
            if (!wert.isTextual() || !vokabular.contains(wert.asText())) {
                throw nein(Grund.WORT_UNBEKANNT, feld + " " + wert.asText());
            }
        }
    }

    private static void pruefeZeit(JsonNode e, Art art, Urheber u) {
        if (art.zeitform() == ZEITRAUM) {
            Instant von = zeit(e, "von");
            if (e.get("bis").isNull()) {
                if (!art.offenErlaubt() || u == BOX) {
                    throw nein(Grund.ZEIT_UNGUELTIG, "offen");
                }
            } else {
                Instant bis = zeit(e, "bis");
                boolean verkehrt = art.grenzen() == HALBOFFEN ? !bis.isAfter(von) : bis.isBefore(von);
                if (verkehrt) {
                    throw nein(Grund.ZEIT_UNGUELTIG, "bis vor von");
                }
                if (art == Art.LATE_ARRIVAL && (von.getEpochSecond() % VIERTELSTUNDE_S != 0
                        || Duration.between(von, bis).getSeconds() != VIERTELSTUNDE_S)) {
                    throw nein(Grund.ZEIT_UNGUELTIG, "keine Viertelstunde im Raster");
                }
            }
            if ((art == Art.SUBSTITUTE || art == Art.CORRECTION)
                    && (von.getEpochSecond() % VIERTELSTUNDE_S != 0
                            || zeit(e, "bis").getEpochSecond() % VIERTELSTUNDE_S != 0)) {
                throw nein(Grund.ZEIT_UNGUELTIG, "nicht im Viertelstunden-Raster");
            }
            if (art == Art.HANDOVER && von.getEpochSecond() % 60 != 0) {
                throw nein(Grund.ZEIT_UNGUELTIG, "von nicht auf der Minute");
            }
        } else if (art == Art.DEVICE_BOUNDARY && zeit(e, "zeitpunkt").getEpochSecond() % 60 != 0) {
            throw nein(Grund.ZEIT_UNGUELTIG, "zeitpunkt nicht auf der Minute");
        }
    }

    private static void pruefeRegeln(JsonNode e, Art art, Urheber u) {
        // Eine Messstelle an einer Reihe braucht die ganze Reihe — außer die Art bezieht sich auf
        // die Messstelle selbst (AP-10 IP-8: verteilung_geaendert).
        boolean ablesung = e.hasNonNull("messstelle") && !e.has("komponente") && !e.has("messkanal")
                && ((art == Art.DATA_GAP && u == CLOUD && !e.has("box")
                        && "kadenz".equals(e.path("erkannt_aus").asText()))
                    || (art == Art.CORRECTION
                        && "ablesestaende_nachgetragen".equals(e.path("korrektur_art").asText())));
        if ((e.has("messkanal") && !e.has("komponente"))
                || (e.has("messstelle") && !ablesung && !art.bezugPflicht().contains("messstelle")
                        && !(e.has("komponente") && e.has("messkanal")))) {
            throw nein(Grund.REGEL_VERLETZT, "Reihe unvollständig");
        }
        switch (art) {
            case DATA_GAP -> {
                String aus = e.get("erkannt_aus").asText();
                if (ERKANNT_AUS.get(aus) != u
                        && !ERKANNT_AUS_AUCH.getOrDefault(aus, Set.of()).contains(u)) {
                    throw nein(Grund.REGEL_VERLETZT, "erkannt_aus " + aus + " von " + u.code());
                }
                String klasse = e.path("fehlerklasse").asText(null);
                boolean herzschlag = "herzschlag".equals(aus);
                if (klasse != null && herzschlag != BOX_MELDET_SICH_NICHT.equals(klasse)) {
                    throw nein(Grund.REGEL_VERLETZT, "Ursache ohne Fakt: " + klasse);
                }
                if (e.hasNonNull("nachgeliefert_am") && e.get("bis").isNull()) {
                    throw nein(Grund.REGEL_VERLETZT, "nachgeliefert, aber offen");
                }
                pruefeZuwachs(e);
            }
            case BACKFILL -> {
                if (zeit(e, "eingang_bis").isBefore(zeit(e, "eingang_von"))
                        || (e.has("erwartet") && e.get("erwartet").asLong() < e.get("anzahl").asLong())) {
                    throw nein(Grund.REGEL_VERLETZT, "Eingang oder Anzahl");
                }
            }
            case DUPLICATE_CONFLICT -> {
                if (gleich(e.get("gespeicherter_wert"), e.get("abgewiesener_wert"))) {
                    throw nein(Grund.REGEL_VERLETZT, "gleicher Wert ist eine Wiederholung");
                }
            }
            case SEQUENCE_GAP -> {
                long erwartet = e.get("sequenz_erwartet").asLong();
                long erhalten = e.get("sequenz_erhalten").asLong();
                if (erhalten <= erwartet || e.get("anzahl").asLong() != erhalten - erwartet) {
                    throw nein(Grund.REGEL_VERLETZT, "Anzahl aus den Sequenzen");
                }
            }
            case SEQUENCE_RESET -> {
                if (e.get("sequenz_erhalten").asLong() >= e.get("sequenz_erwartet").asLong()) {
                    throw nein(Grund.REGEL_VERLETZT, "Sequenz nicht zurück");
                }
            }
            case COUNTER_RESET -> {
                if (zahl(e, "stand_neu").compareTo(zahl(e, "stand_alt")) >= 0
                        || (e.has("messzeit_alt")
                                && !zeit(e, "messzeit_alt").isBefore(zeit(e, "zeitpunkt")))) {
                    throw nein(Grund.REGEL_VERLETZT, "Stand fällt nicht");
                }
            }
            case COUNTER_OVERFLOW -> {
                // Z6 (AP-08 E4): dieselbe Entscheidung wie die Mengenregel - nur ein fallender Stand
                // mit Deklaration und plausiblem Zuwachs ist ein Überlauf, alles andere eine Rücksetzung.
                Instant alt = zeit(e, "messzeit_alt");
                Instant neu = zeit(e, "zeitpunkt");
                long kadenzS = e.get("kadenz_s").asLong();
                if (!alt.isBefore(neu) || kadenzS < 1
                        || zahl(e, "wertebereich_modul").signum() <= 0
                        || zahl(e, "hoechstzuwachs_je_kadenz").signum() <= 0
                        || VerbrauchRegeln.ueberlauf(new VerbrauchRegeln.Rohwert(alt, zahl(e, "stand_alt")),
                        new VerbrauchRegeln.Rohwert(neu, zahl(e, "stand_neu")), Duration.ofSeconds(kadenzS),
                        zahl(e, "wertebereich_modul"), zahl(e, "hoechstzuwachs_je_kadenz")) == null) {
                    throw nein(Grund.REGEL_VERLETZT, "kein plausibler Überlauf");
                }
            }
            case DEVICE_BOUNDARY -> {
                if (zeit(e, "eingetragen_am").isBefore(zeit(e, "zeitpunkt"))) {
                    throw nein(Grund.REGEL_VERLETZT, "Grenze im Voraus");
                }
                boolean gleicherEinbau = e.get("einbau_alt").asText().equals(e.get("einbau_neu").asText());
                if (gleicherEinbau != GRENZE_OHNE_GERAETEWECHSEL.contains(e.get("anlass").asText())) {
                    throw nein(Grund.REGEL_VERLETZT, "Einbau passt nicht zum Anlass");
                }
            }
            case HANDOVER -> {
                if (e.get("box_alt").asText().equals(e.get("box_neu").asText())) {
                    throw nein(Grund.REGEL_VERLETZT, "Übergabe an dieselbe Box");
                }
            }
            case UNASSIGNED_READER -> {
                if (Duration.between(zeit(e, "von"), zeit(e, "bis")).getSeconds()
                                >= MesswertHerkunft.UNASSIGNED_READER_HOECHSTENS_JE_S
                        || e.path("zustaendige_box").asText("").equals(e.get("box").asText())) {
                    throw nein(Grund.REGEL_VERLETZT, "höchstens eines je Stunde");
                }
            }
            case REJECTED -> {
                boolean herkunft = Grund.HERKUNFT_UNVOLLSTAENDIG.code().equals(e.get("grund").asText());
                if (herkunft != (u == WRITER)) {
                    throw nein(Grund.REGEL_VERLETZT, "Grund passt nicht zum Urheber");
                }
            }
            case CLOCK_AHEAD -> schwelle(e.get("vor_s").asLong(), MesswertHerkunft.ZUKUNFT_HOECHSTENS_S);
            case TOO_OLD -> schwelle(e.get("alter_s").asLong(), MesswertHerkunft.VERGANGENHEIT_HOECHSTENS_S);
            case CLOCK_JUMP -> schwelle(Math.abs(e.get("sprung_s").asLong()), MesswertHerkunft.ZEITSPRUNG_AB_S);
            case DEVICE_RESTART -> {
                if (e.has("herzschlag_vorher") && e.has("herzschlag_nachher")
                        && e.get("herzschlag_nachher").asLong() >= e.get("herzschlag_vorher").asLong()) {
                    throw nein(Grund.REGEL_VERLETZT, "Herzschlag springt nicht zurück");
                }
            }
            case FROZEN_SOURCE -> {
                if (e.has("lesungen") && e.get("lesungen").asLong() < 3) {
                    throw nein(Grund.REGEL_VERLETZT, "weniger als 3 Lesungen");
                }
            }
            case LAYOUT_CHANGED -> {
                paar(e, "fassung_erwartet", "fassung_gelesen");
                paar(e, "karten_erwartet", "karten_gelesen");
            }
            case SUBSTITUTE -> {
                if (!ERSATZWERT_KENNUNG.matcher(e.get("ersatzwert").asText()).matches()) {
                    throw nein(Grund.REGEL_VERLETZT, "keine Ersatzwert-Kennung");
                }
            }
            case CORRECTION -> {
                // AP-09 IP-7: nicht beides — und Fassungen und Import gibt es nur an einer Bezugsgröße.
                boolean anBezugsgroesse = e.has("bezugsgroesse");
                boolean anAblesung = !anBezugsgroesse && e.has("messstelle") && !e.has("komponente");
                if (anAblesung && (e.has("messkanal") || e.has("import")
                        || !"ablesestaende_nachgetragen".equals(e.path("korrektur_art").asText())
                        || (e.has("fassung_alt") != e.has("fassung_neu"))
                        || (e.has("fassung_neu") && e.path("fassung_neu").asInt() <= e.path("fassung_alt").asInt()))) {
                    throw nein(Grund.REGEL_VERLETZT, "Ablesungs-Korrektur passt nicht zur Messstelle");
                }
                if (anBezugsgroesse && (e.has("komponente") || e.has("messkanal"))) {
                    throw nein(Grund.REGEL_VERLETZT, "Reihe oder Bezugsgröße, nicht beides");
                }
                if (!anBezugsgroesse && !anAblesung && (e.has("fassung_alt") || e.has("fassung_neu") || e.has("import"))) {
                    throw nein(Grund.REGEL_VERLETZT, "Fassungen und Import nur an einer Bezugsgröße");
                }
                Pattern kennung = anBezugsgroesse ? BERICHTIGUNG_KENNUNG : KORREKTUR_KENNUNG;
                boolean importKorrektur = anBezugsgroesse && e.has("import")
                        && e.path("korrektur").asText().matches("^I-[0-9]{4}-[0-9]{4,}/Zeile-[1-9][0-9]*/Fassung-[1-9][0-9]*$")
                        && e.path("korrektur").asText().startsWith(e.path("import").asText()+"/Zeile-")
                        && e.path("korrektur").asText().endsWith("/Fassung-"+e.path("fassung_neu").asInt());
                if (!importKorrektur && !kennung.matcher(e.get("korrektur").asText()).matches()) {
                    throw nein(Grund.REGEL_VERLETZT, "keine Korrektur-Kennung");
                }
                // E14: nie automatisch — über Freigabe, Ablehnung und Rücknahme entscheidet ein Mensch.
                if (u == CLOUD && !KORREKTUR_STATUS.get(0).equals(e.get("status").asText())) {
                    throw nein(Grund.REGEL_VERLETZT, "die Cloud schlägt nur vor");
                }
                boolean mitErsatzwert = KORREKTUR_ART_ERSATZWERT.equals(e.get("korrektur_art").asText());
                if (mitErsatzwert != e.has("ersatzwert")) {
                    throw nein(Grund.REGEL_VERLETZT, "Ersatzwert passt nicht zur Art");
                }
                if (mitErsatzwert && !ERSATZWERT_KENNUNG.matcher(e.get("ersatzwert").asText()).matches()) {
                    throw nein(Grund.REGEL_VERLETZT, "keine Ersatzwert-Kennung");
                }
                if (anBezugsgroesse) {
                    if (!KORREKTUR_ART_BEZUGSWERT.equals(e.get("korrektur_art").asText())) {
                        throw nein(Grund.REGEL_VERLETZT, "ein Bezugsgrößen-Wert wird berichtigt");
                    }
                    if (e.get("fassung_neu").asLong() <= e.get("fassung_alt").asLong()) {
                        throw nein(Grund.REGEL_VERLETZT, "fassung_neu folgt nicht auf fassung_alt");
                    }
                    if (e.has("import") && !IMPORT_KENNUNG.matcher(e.get("import").asText()).matches()) {
                        throw nein(Grund.REGEL_VERLETZT, "keine Import-Kennung");
                    }
                }
            }
            case BILANZ_NEU_BERECHNET -> {
                if (!AUSLOESER_KENNUNG.matcher(e.get("ausloeser").asText()).matches()) {
                    throw nein(Grund.REGEL_VERLETZT, "kein Auslöser (Korrektur oder Ersatzwert)");
                }
            }
            // AP-12 IP-4: der Bezug ist ein Bericht; eine Freigabe nennt die Prüfsumme eines Abzugs; der Datenstand
            // liegt nie nach dem Zeitpunkt der Meldung (D1/D3).
            case BERICHT_FREIGEGEBEN, BERICHT_REVISION_ANGESTOSSEN, BERICHT_ENTWURF_NEU_GEBILDET, BERICHT_ABGERUFEN -> {
                if (!BERICHT_KENNUNG.matcher(e.get("bericht").asText()).matches()) {
                    throw nein(Grund.REGEL_VERLETZT, "keine Berichts-Kennung");
                }
                if (e.has("pruefsumme") && !PRUEFSUMME.matcher(e.get("pruefsumme").asText()).matches()) {
                    throw nein(Grund.REGEL_VERLETZT, "keine Prüfsumme eines Abzugs");
                }
                if (e.has("datenstand") && zeit(e, "zeitpunkt").isBefore(zeit(e, "datenstand"))) {
                    throw nein(Grund.REGEL_VERLETZT, "Datenstand nach dem Zeitpunkt");
                }
            }
            case KENNZAHL_NEU_GEBILDET -> {
                if (!KENNZAHL_AUSLOESER.matcher(e.get("ausloeser").asText()).matches()) {
                    throw nein(Grund.REGEL_VERLETZT, "kein Auslöser (Korrektur, Ersatzwert, Berichtigung oder Kennzeichen)");
                }
                // AP-11 IP-8: Version 1 bildet der Regellauf ohne Meldung — neu gebildet ist erst Version n + 1.
                if (e.get("version").asLong() < 2) {
                    throw nein(Grund.REGEL_VERLETZT, "keine Version n + 1");
                }
            }
            case ERROR_CHANGE, STATE_CHANGE, BITFIELD_CHANGE, TEXT_CHANGE -> {
                if (gleich(e.get("alt"), e.get("neu"))) {
                    throw nein(Grund.REGEL_VERLETZT, "kein Übergang");
                }
            }
            default -> {
                // late_arrival: Zeitregel oben; box_restart: nichts weiter
            }
        }
    }

    /**
     * AP-08 IP-6 — der Zuwachs über eine Lücke: alle vier Felder oder keines, nur an einer
     * geschlossenen Lücke EINER Reihe, und er IST die Differenz der Stände (nie negativ). Die Box
     * kann ihn gar nicht senden (ihr Drahtschema kennt die Felder nicht).
     */
    private static void pruefeZuwachs(JsonNode e) {
        long da = ZUWACHS_FELDER.stream().filter(e::has).count();
        if (da == 0) {
            return;
        }
        if (da < ZUWACHS_FELDER.size()) {
            throw nein(Grund.REGEL_VERLETZT, "Zuwachs nur mit zuwachs, einheit, stand_vor und stand_nach");
        }
        if (e.get("bis").isNull()) {
            throw nein(Grund.REGEL_VERLETZT, "Zuwachs, aber offen");
        }
        if (!e.has("komponente") || !e.has("messkanal")) {
            throw nein(Grund.REGEL_VERLETZT, "Zuwachs ohne Reihe");
        }
        BigDecimal zuwachs = zahl(e, "zuwachs");
        if (zuwachs.signum() < 0 || zuwachs.compareTo(zahl(e, "stand_nach").subtract(zahl(e, "stand_vor"))) != 0) {
            throw nein(Grund.REGEL_VERLETZT, "zuwachs ist nicht stand_nach − stand_vor");
        }
    }

    private static void schwelle(long wert, long schwelle) {
        if (wert <= schwelle) {
            throw nein(Grund.REGEL_VERLETZT, wert + " s ≤ " + schwelle + " s");
        }
    }

    private static void paar(JsonNode e, String erwartet, String gelesen) {
        if (e.has(erwartet) != e.has(gelesen)
                || (e.has(erwartet) && e.get(erwartet).asLong() == e.get(gelesen).asLong())) {
            throw nein(Grund.REGEL_VERLETZT, erwartet + "/" + gelesen);
        }
    }

    private static Instant zeit(JsonNode e, String feld) {
        JsonNode w = e.path(feld);
        if (!istZeit(w)) {
            throw nein(Grund.SCHEMA_VERLETZT, "Zeit " + feld);
        }
        return Instant.parse(w.asText());
    }

    private static BigDecimal zahl(JsonNode e, String feld) {
        return e.get(feld).decimalValue();
    }

    /** Gleich heißt: dieselben Felder, Zahlen nach Betrag (1.0 = 1), Texte und Wahrheitswerte wörtlich. */
    static boolean gleich(JsonNode a, JsonNode b) {
        if (a == null || b == null) {
            return a == b;
        }
        if (a.isNumber() && b.isNumber()) {
            return a.decimalValue().compareTo(b.decimalValue()) == 0;
        }
        if (a.isObject() && b.isObject()) {
            if (a.size() != b.size()) {
                return false;
            }
            for (Iterator<String> it = a.fieldNames(); it.hasNext(); ) {
                String f = it.next();
                if (!gleich(a.get(f), b.get(f))) {
                    return false;
                }
            }
            return true;
        }
        if (a.isArray() && b.isArray()) {
            if (a.size() != b.size()) {
                return false;
            }
            for (int i = 0; i < a.size(); i++) {
                if (!gleich(a.get(i), b.get(i))) {
                    return false;
                }
            }
            return true;
        }
        return a.equals(b);
    }
}
