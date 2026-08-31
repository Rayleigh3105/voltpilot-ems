package com.voltpilot.api.fahrzeuge;

import com.voltpilot.api.verbraucher.Steuerart;
import com.voltpilot.api.verbraucher.SteuerartProjektion;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Die REGELN eines Fahrzeug-Profils (Verbrauchsmanagement v1 / P7,
 * Konzept §4.5, Captain-Entscheid E4) - rein, ohne Datenbank, ohne Uhr, das
 * {@code SteuerartSatz}/{@code Tagesprotokoll}-Muster.
 *
 * <p><b>⚠ EIN PROFIL TRÄGT EINE QUELLE UND NIE EIN ZIEL.</b> Das ist keine
 * Sparmaßnahme, sondern folgt aus der Maschine: ein ZIEL („bis 06:00 fertig")
 * ist eine Anforderung einer POLICY, die der Optimierer Stunden im Voraus für
 * eine KOMPONENTE plant - und welches Auto dann dort steckt, weiß zum
 * Planungszeitpunkt niemand. Die QUELLE dagegen ist eine Entscheidung des
 * Augenblicks, und genau die fährt die Box je Sitzung (die P5-Teilung „die
 * Quelle fährt die Box, das Ziel fährt die Policy", eine Ebene feiner).
 *
 * <p><b>⚠ Und deshalb kennt ein Profil nur ZWEI Quellen.</b> „Günstige Stunden"
 * ist ein Preisfenster und damit ebenfalls eine Policy - die Bahn der Box kennt
 * dafür kein Wort. Angeboten wird also genau das, was die Bahn ausdrücken kann:
 * {@code sofort} und {@code ueberschuss}. Eine Wahl anzubieten, die der Server
 * danach ablehnen müsste, wäre die Sorte Zusage, die dieses Haus nicht macht.
 *
 * <p><b>⚠ Der SCHLÜSSEL ist der Pseudonym der BOX.</b> Er ist kein Geheimnis
 * und kein Klartext, sondern ein HMAC mit dem Geräteschlüssel; die Cloud kann
 * ihn nicht bilden, sie kann ihn nur wiederholen. Der Bezug aus dem
 * OCPP-Journal ({@code ocpp_transaction.start_id_tag_ref}) ist ein ANDERER Wert
 * für dieselbe Karte - die Cloud pfeffert ihn beim Ingest ein zweites Mal.
 */
public final class FahrzeugSteuerart {

    private FahrzeugSteuerart() {}

    /** Die Form, die nur die Box selbst gebildet haben kann. */
    public static final Pattern TAG_REF = Pattern.compile("^tagref_[0-9a-f]{8,64}$");

    /** Die längste Namenslänge, die die Migration zulässt. */
    public static final int MAX_NAME = 120;

    /**
     * Die Quellen, die ein Profil tragen kann - die zwei, die die Quellen-Bahn
     * der Box ausdrücken kann. Reihenfolge wie am Ladepunkt: „Sofort" führt.
     */
    public static final List<String> QUELLEN =
            List.of(SteuerartProjektion.QUELLE_SOFORT, SteuerartProjektion.QUELLE_UEBERSCHUSS);

    public static final String GRUND_ZIEL =
            "Ein Ziel gehört zum Ladepunkt, nicht zum Fahrzeug: es wird Stunden im Voraus "
                    + "geplant, und welches Auto dann dort steckt, weiß niemand.";

    public static final String GRUND_UNBEKANNTE_KARTE =
            "Diese Ladekarte hat an dieser Anlage noch nicht geladen.";

    /** Ein Wunsch, wie ihn der Dialog schickt. Alles außer der Quelle optional. */
    public record Wunsch(String name, String quelle, String ueberschussModus,
            BigDecimal mindestleistungKw) {}

    /** Die Bahn + Mindestleistung, die zur Box reisen. */
    public record Bahn(String source, BigDecimal minKw) {}

    /**
     * Prüft einen Wunsch und sammelt ALLE Mängel (das
     * {@code ComponentTemplateDefinition}-Muster: ein Formular, das einen
     * Fehler nach dem anderen ausspuckt, ist kein Formular).
     *
     * @param name der Name, den der Kunde vergeben hat; leer = keiner
     */
    public static List<String> pruefe(Wunsch w) {
        List<String> fehler = new ArrayList<>();
        if (w == null) {
            fehler.add("Es wurde nichts übermittelt.");
            return fehler;
        }
        String name = w.name() == null ? "" : w.name().trim();
        if (name.length() > MAX_NAME) {
            fehler.add("Der Name darf höchstens " + MAX_NAME + " Zeichen lang sein.");
        }
        String quelle = w.quelle() == null ? "" : w.quelle().trim();
        if (!quelle.isEmpty() && !QUELLEN.contains(quelle)) {
            // ⚠ „Günstige Stunden" und jedes Ziel werden BEIM NAMEN genannt,
            // nicht als „ungültig" abgetan: der Kunde hat die Wörter auf der
            // Ladepunkt-Zeile gesehen, und ein Formular, das den Unterschied
            // nicht erklärt, sieht nach einem Fehler aus.
            if (SteuerartProjektion.QUELLE_GUENSTIG.equals(quelle)
                    || SteuerartProjektion.QUELLE_FESTE_ZEITEN.equals(quelle)) {
                fehler.add(GRUND_ZIEL);
            } else {
                fehler.add("Unbekannte Steuerart „" + quelle + "“.");
            }
        }
        if (SteuerartProjektion.QUELLE_UEBERSCHUSS.equals(quelle)
                && SteuerartProjektion.MODUS_MINDESTLEISTUNG.equals(w.ueberschussModus())) {
            BigDecimal kw = w.mindestleistungKw();
            if (kw != null && (kw.signum() < 0 || kw.compareTo(BigDecimal.valueOf(1000)) > 0)) {
                fehler.add("Die Mindestleistung muss zwischen 0 und 1000 kW liegen.");
            }
        }
        return fehler;
    }

    /**
     * Die Bahn, die dieses Profil zur Box schickt - über die EINE geteilte
     * Abbildung {@link SteuerartProjektion#bahnAus}, damit eine Karte nie
     * anders lädt, als ihre Säule es unter derselben Wahl täte.
     *
     * @return {@code null}, wenn der Wunsch keine Quelle NENNT ({@code null} =
     *         nichts ändern) oder sie ausdrücklich LEERT ({@code ""} = das
     *         Profil zurücknehmen). Welcher der beiden Fälle vorliegt,
     *         entscheidet {@link #setztBahn} - siehe dort.
     */
    /**
     * Soll die Steuerart überhaupt ANGEFASST werden?
     *
     * <p>⚠ DREI Zustände, die Haus-Regel jeder PATCH-Route: der Schlüssel
     * FEHLT = „an der Steuerart nichts ändern"; ein Wort SETZT sie; die LEERE
     * Zeichenkette NIMMT SIE ZURÜCK. Ohne den dritten Zustand gäbe es keinen
     * Weg zurück, ohne zugleich den Namen zu verlieren - der Dialog bietet
     * „Lädt wie der Ladepunkt" ausdrücklich als Wahl an und verspricht in
     * seiner Folgen-Karte „lädt weiterhin so, wie der Ladepunkt es vorgibt";
     * ein Speichern, das die gespeicherte Quelle stehen ließe, bräche genau
     * dieses Versprechen (im Review gefunden, nicht im Test).
     */
    public static boolean setztBahn(Wunsch w) {
        return w != null && w.quelle() != null;
    }

    public static Bahn bahn(Wunsch w) {
        String quelle = w == null || w.quelle() == null ? "" : w.quelle().trim();
        if (quelle.isEmpty()) {
            return null;
        }
        String bahn = SteuerartProjektion.bahnAus(quelle, w.ueberschussModus());
        // ⚠ Der Boden reist NUR mit, wenn er auch gemeint ist: bei „pausieren"
        // wäre er eine Zahl ohne Wirkung, die die Box als „sonne_zuerst"
        // missverstehen könnte (die wunschAus-Regel des Dialogs).
        BigDecimal minKw = SteuerartProjektion.POLICY_SONNE_ZUERST.equals(bahn)
                ? w.mindestleistungKw() : null;
        return new Bahn(bahn, minKw);
    }

    /**
     * Die ANZEIGE-Form eines gespeicherten Profils: dieselbe Projektion, die
     * eine Säule benutzt, damit Fahrzeug-Zeile und Ladepunkt-Zeile dieselben
     * Wörter tragen. {@code null} = kein Profil, nur eine Sichtung.
     */
    public static Steuerart steuerart(String source, BigDecimal minKw) {
        if (source == null || source.isBlank()) {
            return null;
        }
        return SteuerartProjektion.saeulenSteuerart(source, minKw, null);
    }

    /** Nur was diese Box gebildet haben kann, kommt als Schlüssel in Frage. */
    public static boolean istPseudonym(String tagRef) {
        return tagRef != null && TAG_REF.matcher(tagRef).matches();
    }

    /** Trimmt einen Namen auf die gespeicherte Form; leer wird {@code null}. */
    public static String name(String raw) {
        if (raw == null) {
            return null;
        }
        String t = raw.trim();
        return t.isEmpty() ? null : t;
    }

    /** Die Kurzform einer Karte für ein Protokoll - NIE der ganze Bezug. */
    public static String kurz(String tagRef) {
        if (tagRef == null || tagRef.length() < 11) {
            return "";
        }
        return tagRef.substring(7, 11).toLowerCase(Locale.ROOT);
    }
}
