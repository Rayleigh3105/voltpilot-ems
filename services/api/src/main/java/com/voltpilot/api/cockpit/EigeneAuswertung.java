package com.voltpilot.api.cockpit;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Die REINE Regel der Anwendung „Eigene Auswertung" (Anwendungs-Programm
 * Stufe 5, Scout {@code vp-portal-zielbild-anwendungen} §3.6 / §5): welcher
 * Baustein-Schlüssel gültig ist, welche Aggregate es gibt — und vor allem,
 * welches Aggregat zu welchem KANAL ehrlich ist.
 *
 * <p>Ohne Datenbank, ohne Spring, ohne Uhr (das
 * {@code Tagesprotokoll}/{@code FleetPflege}/{@code SelfBuildDefinition}-Muster):
 * jede Regel, die eine eigene Kachel verhindern kann, ist ohne einen einzigen
 * Container prüfbar.
 *
 * <h2>⚠ DIE EHRLICHKEITSREGEL, und warum sie hier und nicht im Portal wohnt</h2>
 *
 * Das Aggregat muss zu dem passen, was der Kanal MISST. Die Fläche spiegelt die
 * Regel (sie bietet eine unehrliche Kombination gar nicht erst an), aber der
 * SERVER entscheidet — dem Client zu glauben wäre keine Prüfung. Beide Seiten
 * fahren dieselben Vektoren ({@code docs/contracts/v2/eigene-auswertung-vectors.json});
 * <b>wer die Regel ändert, ändert beide Seiten und die Vektor-Datei.</b>
 *
 * <pre>
 *   Kanalart   | erkannt an              | jetzt | tagessumme | tagesmax | tagesmittel
 *   -----------+-------------------------+-------+------------+----------+------------
 *   energie    | *_kwh, *_wh, *energy*   |   ja  |     ja     |   nein   |    nein
 *   leistung   | *_kw, *_w, *power*      |   ja  |    nein    |    ja    |     ja
 *   anteil     | *_pct                   |   ja  |    nein    |    ja    |     ja
 *   messwert   | alles Übrige            |   ja  |    nein    |    ja    |     ja
 * </pre>
 *
 * Die zwei Verbote hängen an DERSELBEN Tatsache — <b>ein kWh-Kanal meldet in
 * diesem Haus einen ZÄHLERSTAND, nicht die Energie eines Intervalls</b> (die
 * Hausregel steht in {@code ConsumerRequirementStateRepository.energyOverPeriod}:
 * die Energie einer Periode ist {@code max − min}, der ZUWACHS):
 *
 * <ol>
 *   <li>Eine Tagessumme über Leistung/Anteil/Temperatur addiert Momentanwerte —
 *       die Summe von 96 kW-Werten ist keine Energie und keine sonstige Größe.
 *   <li>Höchstwert und Mittelwert eines ZÄHLERSTANDS sind keine Aussage: der
 *       Höchststand ist der Endstand des Tages, das Mittel liegt irgendwo
 *       dazwischen. Ein Energiekanal kennt deshalb nur den STAND ({@code jetzt})
 *       und den ZUWACHS des Tages ({@code tagessumme}).
 * </ol>
 *
 * <p><b>Die Kanalart kommt aus dem NAMEN, nicht aus der gemeldeten Einheit.</b>
 * Das Kanal-Vokabular ist offen (ein Selbstbau-Gerät benennt seine Kanäle
 * selbst, MB-M1), und die Einheit ist optional — ein Kanal ohne Einheit hätte
 * sonst gar keine Art. Ein UNBEKANNTER Kanal ist {@code messwert}: er bekommt
 * jedes Aggregat ausser der Summe, nie eine erfundene Einheit.
 */
public final class EigeneAuswertung {

    private EigeneAuswertung() {}

    /** Das Präfix, an dem ein EIGENER Baustein erkennbar ist. */
    public static final String PREFIX = "eigen:";

    /** Der Wert JETZT — der jüngste gemeldete Messwert. */
    public static final String AGG_JETZT = "jetzt";
    /** Der ZUWACHS des Tages — nur auf einem Energie-Kanal. */
    public static final String AGG_TAGESSUMME = "tagessumme";
    /** Der höchste Wert des Tages. */
    public static final String AGG_TAGESMAX = "tagesmax";
    /** Das (stichproben-gewichtete) Mittel des Tages. */
    public static final String AGG_TAGESMITTEL = "tagesmittel";

    /** Eine Kachel mit EINER Zahl. */
    public static final String DARSTELLUNG_KACHEL = "kachel";
    /** Ein Verlaufs-Chart des Tages, mit der Kennzahl als Kopfzeile. */
    public static final String DARSTELLUNG_CHART = "chart";

    /** Ein Zählerstand in kWh/Wh. */
    public static final String ART_ENERGIE = "energie";
    /** Eine Leistung in kW/W. */
    public static final String ART_LEISTUNG = "leistung";
    /** Ein Prozentwert. */
    public static final String ART_ANTEIL = "anteil";
    /** Alles Übrige — Temperatur, Spannung, ein selbst benannter Kanal. */
    public static final String ART_MESSWERT = "messwert";

    /** Die Aggregate in ihrer Anzeige-Reihenfolge. */
    public static final List<String> AGGREGATE =
            List.of(AGG_JETZT, AGG_TAGESSUMME, AGG_TAGESMAX, AGG_TAGESMITTEL);

    /** Die zwei Darstellungen. */
    public static final List<String> DARSTELLUNGEN =
            List.of(DARSTELLUNG_KACHEL, DARSTELLUNG_CHART);

    /**
     * Wie viele eigene Bausteine eine Anlage höchstens trägt. Kein Geschmack:
     * jeder eigene Baustein kostet beim Rendern eine Messwert-Abfrage, und ein
     * Dokument ohne Deckel könnte unbegrenzt wachsen.
     */
    public static final int MAX_BAUSTEINE = 12;

    /** Die Länge eines Titels — er steht als Überschrift auf einer Kachel. */
    public static final int MAX_TITEL = 60;

    /**
     * Ein eigener Baustein, wie er im Layout-Dokument steht
     * ({@code document.custom[]}).
     *
     * @param id           der Baustein-Schlüssel ({@code eigen:…}) — er steht
     *                     zugleich in {@code order}/{@code hidden}
     * @param titel        die Überschrift, die der Kunde vergeben hat
     * @param darstellung  {@code kachel} | {@code chart}
     * @param entityId     die Komponente dieser Anlage
     * @param channel      ihr Messwert-Kanal
     * @param aggregat     eines von {@link #AGGREGATE}
     */
    public record CustomBaustein(String id, String titel, String darstellung, String entityId,
            String channel, String aggregat) {}

    /** Ein Befund der Form-Prüfung: der deutsche Grund, oder null = in Ordnung. */
    public static String pruefeForm(CustomBaustein b) {
        if (b == null) {
            return "Es wurde keine eigene Auswertung übergeben.";
        }
        if (!istEigen(b.id())) {
            return "Der Schlüssel einer eigenen Auswertung beginnt mit „eigen:“.";
        }
        if (b.id().length() <= PREFIX.length() || b.id().length() > 64
                || !b.id().substring(PREFIX.length()).matches("[a-z0-9][a-z0-9-]*")) {
            return "„" + b.id() + "“ ist kein gültiger Schlüssel für eine eigene Auswertung.";
        }
        if (b.titel() == null || b.titel().isBlank()) {
            return "Geben Sie Ihrer Auswertung eine Überschrift.";
        }
        if (b.titel().length() > MAX_TITEL) {
            return "Die Überschrift ist länger als " + MAX_TITEL + " Zeichen.";
        }
        if (!DARSTELLUNGEN.contains(b.darstellung())) {
            return "Unbekannte Darstellung — erlaubt sind „Kachel“ und „Verlauf“.";
        }
        if (b.entityId() == null || b.entityId().isBlank()) {
            return "Wählen Sie die Komponente, deren Messwert Sie sehen möchten.";
        }
        if (b.channel() == null || b.channel().isBlank()) {
            return "Wählen Sie den Messwert, den Sie sehen möchten.";
        }
        if (!AGGREGATE.contains(b.aggregat())) {
            return "Unbekannte Kennzahl — erlaubt sind „Aktuell“, „Tagessumme“, "
                    + "„Tageshöchstwert“ und „Tagesmittel“.";
        }
        return null;
    }

    /** Trägt dieser Schlüssel das Präfix einer eigenen Auswertung? */
    public static boolean istEigen(String id) {
        return id != null && id.startsWith(PREFIX);
    }

    /**
     * Die Art eines Kanals — abgeleitet aus seinem NAMEN (siehe Klassenkopf).
     * Ein leerer Name ist {@code messwert}: ohne Namen gibt es keinen Hinweis,
     * und {@code messwert} ist die Art, die am wenigsten behauptet.
     */
    public static String kanalart(String channel) {
        if (channel == null) {
            return ART_MESSWERT;
        }
        String c = channel.toLowerCase(Locale.ROOT);
        // ⚠ DIE REIHENFOLGE IST EINE REGEL, kein Stil:
        //  1. `_pct` ZUERST — ein Prozentsuffix ist die eindeutigste Aussage,
        //     die ein Kanalname machen kann. Stünde es hinter der Energie,
        //     bekäme ein `energy_pct` die Tagessumme eines Zählerstands, also
        //     eine Summe über Prozentwerte.
        //  2. Energie VOR Leistung — `energy_kwh` endet auf `_kwh` UND enthält
        //     `energy`, und `_kwh` endet nicht auf `_kw`; die Reihenfolge hält
        //     beides eindeutig, auch für einen selbst benannten `zaehler_wh`.
        if (c.endsWith("_pct") || c.endsWith("_prozent")) {
            return ART_ANTEIL;
        }
        if (c.endsWith("_kwh") || c.endsWith("kwh") || c.endsWith("_wh") || c.contains("energy")
                || c.contains("energie")) {
            return ART_ENERGIE;
        }
        if (c.endsWith("_kw") || c.endsWith("_w") || c.contains("power")
                || c.contains("leistung")) {
            return ART_LEISTUNG;
        }
        return ART_MESSWERT;
    }

    /**
     * Darf dieses Aggregat auf diesem Kanal stehen?
     *
     * <p>⚠ Der {@code null}-Schutz steht VOR dem {@code contains}: {@code List.of}
     * wirft bei {@code contains(null)} eine NPE (dieselbe Falle, die schon den
     * Regal-Aufbau einmal in einen 500 gerissen hat) — ein fehlendes Aggregat
     * muss hier ein sauberes „nein" sein, nicht ein Absturz.
     */
    public static boolean erlaubt(String channel, String aggregat) {
        if (aggregat == null || !AGGREGATE.contains(aggregat)) {
            return false;
        }
        if (AGG_JETZT.equals(aggregat)) {
            // Der jüngste gemeldete Wert ist auf JEDEM Kanal eine ehrliche
            // Aussage — er ist genau das, was das Gerät gemeldet hat.
            return true;
        }
        boolean energie = ART_ENERGIE.equals(kanalart(channel));
        return AGG_TAGESSUMME.equals(aggregat) == energie;
    }

    /**
     * Der deutsche Grund für eine unehrliche Kombination — er benennt die
     * KANALART und die AUSWEGE, nie nur „ungültig". Null, wenn sie erlaubt ist.
     *
     * <p><b>Ohne {@code label} steht der ROHE Kanalname im Satz</b>, und das ist
     * die dokumentierte Hausregel für ein offenes Vokabular („ein unbekannter
     * Kanal rendert seinen Rohnamen statt eines erfundenen Labels", siehe
     * {@code frontend/portal/src/channels.ts}) — der Server hält kein deutsches
     * Kanal-Wörterbuch, und eines einzuführen wäre ein weiterer Zwilling. In der
     * Praxis erreicht dieser Satz einen Kunden ohnehin nur, wenn die Fläche
     * umgangen wurde: sie bietet eine unehrliche Kombination gar nicht erst an
     * und benennt sie mit dem deutschen Namen des Messwerts.
     *
     * @param label der kundenseitige Name des Messwerts, oder null
     */
    public static String grund(String channel, String aggregat, String label) {
        if (erlaubt(channel, aggregat)) {
            return null;
        }
        String name = label == null || label.isBlank() ? channel : label;
        if (AGG_TAGESSUMME.equals(aggregat)) {
            // „eine Leistung — sie" / „ein Prozentwert — er": Artikel und
            // Pronomen gehören zusammen, sonst entsteht ein falscher Satz.
            String art = switch (kanalart(channel)) {
                case ART_LEISTUNG -> "eine Leistung \u2014 sie";
                case ART_ANTEIL -> "ein Prozentwert \u2014 er";
                default -> "ein Messwert \u2014 er";
            };
            return "\u201e" + name + "\u201c ist " + art + " l\u00e4sst sich nicht zu einer "
                    + "Tagessumme addieren. W\u00e4hlen Sie \u201eAktuell\u201c, "
                    + "\u201eTagesh\u00f6chstwert\u201c oder \u201eTagesmittel\u201c.";
        }
        if (AGG_TAGESMAX.equals(aggregat)) {
            return "\u201e" + name + "\u201c ist ein Z\u00e4hlerstand \u2014 sein "
                    + "H\u00f6chstwert ist immer der letzte Stand des Tages. W\u00e4hlen Sie "
                    + "\u201eAktuell\u201c oder \u201eTagessumme\u201c.";
        }
        if (AGG_TAGESMITTEL.equals(aggregat)) {
            return "\u201e" + name + "\u201c ist ein Z\u00e4hlerstand \u2014 ein Mittelwert "
                    + "daraus ist keine Aussage. W\u00e4hlen Sie \u201eAktuell\u201c oder "
                    + "\u201eTagessumme\u201c.";
        }
        return "Diese Kennzahl passt nicht zu „" + name + "“.";
    }

    /**
     * Die Aggregate, die auf diesem Kanal ehrlich sind — in Anzeige-Reihenfolge.
     * Nie leer: {@link #AGG_JETZT} gilt immer.
     */
    public static List<String> erlaubteAggregate(String channel) {
        return AGGREGATE.stream().filter(a -> erlaubt(channel, a)).toList();
    }

    /**
     * Doppelte Schlüssel in einer Liste eigener Bausteine — ein Dokument, das
     * denselben Schlüssel zweimal definiert, hat zwei Wahrheiten über eine
     * Kachel.
     */
    public static String ersterDoppelter(List<CustomBaustein> custom) {
        Set<String> seen = new LinkedHashSet<>();
        for (CustomBaustein b : custom) {
            if (b != null && b.id() != null && !seen.add(b.id())) {
                return b.id();
            }
        }
        return null;
    }
}
