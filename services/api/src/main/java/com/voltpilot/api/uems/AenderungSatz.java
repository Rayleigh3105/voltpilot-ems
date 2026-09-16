package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import java.text.NumberFormat;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Der KUNDENSATZ eines Protokolleintrags (UEMS AP-04 IP-21): „was wurde geändert“ in einem
 * Satz, ausschließlich aus den FAKTEN des Eintrags — nie eine geratene Ursache
 * (Hausregel „Ehrlichkeit der Zahlen“).
 *
 * <p>Rein: kein Spring, keine Datenbank, keine Uhr. WANN die Änderung gilt, WANN sie
 * eingetragen wurde, WER sie war und ob sie rückwirkend oder angekündigt war, sagt die Zeile
 * selbst — dieser Satz sagt nur das WAS. Die Größen-, Richtungs- und Stellungswörter stehen
 * schon als Kundenwörter im JSON (Vertrag {@code messstelle.schema.json}) und werden
 * unverändert übernommen; ein Feld, das fehlt, wird weggelassen statt erfunden.
 *
 * <p>Eine unbekannte Art fällt nicht durch: sie bekommt ihren Code als Satz, damit ein neuer
 * Schreibweg sichtbar ist, statt still zu verschwinden.
 */
public final class AenderungSatz {

    private AenderungSatz() {}

    /** Die Kundenwörter der Bezugsarten ({@code ort_aenderung.objekt_art} und die Messstelle). */
    private static final Map<String, String> BEZUG = Map.of(
            "messstelle", "Messstelle",
            "datenquelle", "Datenquelle",
            "unternehmen", "Unternehmen",
            "standort", "Standort",
            "gebaeude", "Gebäude",
            "bereich", "Bereich",
            "anlage", "Anlage");

    /** Die Kundenwörter der bearbeitbaren Felder — für „bearbeitet“, das nur Geändertes trägt. */
    private static final Map<String, String> FELD = felder();

    private static Map<String, String> felder() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("kennzeichen", "Kennzeichen");
        m.put("name", "Name");
        m.put("kurzname", "Kurzname");
        m.put("kurzzeichen", "Kurzzeichen");
        m.put("notiz", "Notiz");
        m.put("adresse", "Adresse");
        m.put("zeitzone", "Zeitzone");
        m.put("protokoll", "Verbindungsweg");
        m.put("kadenz_s", "Lesetakt");
        m.put("netz", "Netzlage");
        m.put("flaeche_m2", "Bezugsfläche");
        return Map.copyOf(m);
    }

    /** Die Rolle einer Quellenbindung als Kundenwort. */
    private static String rolle(String code) {
        return "vergleich".equals(code) ? "Vergleich" : "fuehrend".equals(code) ? "führend" : code;
    }

    /**
     * Der Satz zu einem Eintrag.
     *
     * @param bezugArt {@code messstelle} · {@code datenquelle} · {@code standort} …
     * @param art der Code des Eintrags ({@code zaehler_gewechselt}, {@code ort_zugeordnet} …)
     * @param alt/neu die beiden Seiten des Eintrags; bei „bearbeitet“ NUR die geänderten Felder
     * @param ergebnis nur bei {@code erreichbarkeit_geprueft} gesetzt
     */
    public static String satz(String bezugArt, String art, JsonNode alt, JsonNode neu, String ergebnis) {
        String was = BEZUG.getOrDefault(bezugArt, "Eintrag");
        return switch (art) {
            case "angelegt" -> mitName(was + " angelegt", neu);
            case "bearbeitet" -> was + " bearbeitet" + geaenderteFelder(alt, neu);
            case "angehalten" -> was + " angehalten";
            case "fortgesetzt" -> was + " fortgesetzt";
            case "archiviert" -> was + " archiviert";
            case "wiederhergestellt" -> was + " wiederhergestellt";
            case "geloescht" -> was + " gelöscht";
            case "verschoben" -> verschoben(was, bezugArt, alt, neu);
            case "korrigiert" -> "Zuordnung berichtigt" + zielZusatz(neu);
            case "flaeche_geaendert" -> "Bezugsfläche geändert" + wechsel(ganzzahl(text(alt, "flaeche_m2")),
                    ganzzahl(text(neu, "flaeche_m2")), " m²");
            case "nebengroesse_hinzugefuegt" -> "Nebengröße hinzugefügt" + groesse(neu);
            case "nebengroesse_archiviert" -> "Nebengröße archiviert" + groesse(neu);
            case "ort_zugeordnet" -> "Ort zugeordnet" + zusatz(text(neu, "kennzeichen"));
            case "ort_korrigiert" -> "Ort berichtigt" + zusatz(text(neu, "kennzeichen"));
            case "stellung_zugeordnet" -> "Elektrische Stellung zugeordnet" + stellung(neu);
            case "stellung_korrigiert" -> "Elektrische Stellung berichtigt" + stellung(neu);
            case "quelle_gebunden" -> "Quelle gebunden" + quelle(neu);
            case "quelle_beendet" -> "Quelle beendet" + zusatz(text(neu, "einbau"));
            case "einstellung_geaendert" -> "Einstellung geändert" + einstellung(alt, neu);
            case "zaehler_gewechselt" -> "Zähler gewechselt" + wechsel(text(neu, "vorgaenger"),
                    text(neu, "einbau"), "");
            case "formel_geaendert" -> "Formel geändert" + zusatz(text(neu, "fassung") == null ? null
                    : "Fassung " + text(neu, "fassung"));
            case "prozesse_zugeordnet" -> "Prozesse zugeordnet" + prozesse(neu);
            case "verteilung_geaendert" -> (neu != null && neu.path("korrektur").asBoolean()
                    ? "Verteilung auf Kostenstellen berichtigt" : "Verteilung auf Kostenstellen geändert") + anteile(neu);
            case "erreichbarkeit_geprueft" -> "Erreichbarkeit geprüft" + zusatz(ergebnis);
            case "zustaendigkeit_begonnen" -> "Zuständigkeit begonnen";
            case "zustaendigkeit_gewechselt" -> "Zuständigkeit gewechselt";
            case "aus_bestand_uebernommen" -> was + " aus dem Bestand übernommen";
            case "zugriff_zugewiesen" -> "Zugriff zugewiesen" + zugriff(neu);
            case "zugriff_entzogen" -> "Zugriff entzogen" + zugriff(neu);
            default -> art;
        };
    }

    /**
     * „: Sabine Rauch · Bearbeiter" — Person und Rolle einer Zuweisungs-Änderung (AP-03 IP-9). Die Rolle steht
     * als Code im Eintrag und wird mit dem KUNDENWORT der Matrix gezeigt; ein unbekannter Code bleibt, wie er
     * ist, statt zu verschwinden.
     */
    private static String zugriff(JsonNode neu) {
        String name = text(neu, "benutzer_name");
        String rolle = text(neu, "rolle");
        if (rolle != null) {
            try {
                rolle = RechteAbleitung.Rolle.vonCode(rolle).kundenwort();
            } catch (IllegalArgumentException e) {
                // unbekannte Rolle: der Code ist ehrlicher als nichts
            }
        }
        if (name == null) {
            return zusatz(rolle);
        }
        return zusatz(rolle == null ? name : name + " · " + rolle);
    }

    // ---------------------------------------------------------------- Bausteine

    private static String mitName(String kopf, JsonNode neu) {
        return kopf + zusatz(text(neu, "name"));
    }

    /** „: Name „Halle 2“ → „Halle Nord“, Notiz geändert“ — nur, was wirklich anders ist. */
    private static String geaenderteFelder(JsonNode alt, JsonNode neu) {
        if (neu == null || !neu.isObject() || neu.isEmpty()) {
            return "";
        }
        List<String> teile = new ArrayList<>();
        neu.fieldNames().forEachRemaining(feld -> {
            String label = FELD.get(feld);
            if (label == null) {
                return;
            }
            String vorher = text(alt, feld);
            String nachher = text(neu, feld);
            teile.add(vorher == null || nachher == null
                    ? label + " geändert"
                    : label + " „" + vorher + "“ → „" + nachher + "“");
        });
        return teile.isEmpty() ? "" : ": " + String.join(", ", teile);
    }

    /**
     * „verschoben“: ein Ort an einen anderen Knoten (Kennzeichen des Ziels) — oder die Zuordnung
     * einer ANLAGE (AP-02 IP-9/IP-11), die jede Seite erzählt: an der Anlage „Standort zugeordnet:
     * Werk Ahrenberg Nord (ST-3)“, am neuen Standort „Anlage zugeordnet: …“, am bisherigen
     * „Anlage zieht um: … → Werk Ahrenberg Nord“. Ein Gebäude oder Bereich mit Namen der Elternknoten
     * (IP-12): „Gebäude verschoben: Werk Ahrenberg → Werk Ahrenberg Nord (ST-3)“.
     */
    private static String verschoben(String was, String bezugArt, JsonNode alt, JsonNode neu) {
        String anlage = text(neu, "anlage_name");
        String richtung = text(neu, "richtung");
        if ("standort".equals(bezugArt) && anlage != null && richtung != null) {
            String nach = text(neu, "nach_standort_name");
            return "hinaus".equals(richtung)
                    ? "Anlage zieht um: " + anlage + (nach == null ? "" : " → " + nach)
                    : "Anlage zugeordnet: " + anlage;
        }
        String standort = text(neu, "standort_name");
        if ("anlage".equals(bezugArt) && standort != null) {
            String kz = text(neu, "standort_kurzzeichen");
            return "Standort zugeordnet: " + standort + (kz == null ? "" : " (" + kz + ")");
        }
        String nach = text(neu, "eltern_name");
        if (("gebaeude".equals(bezugArt) || "bereich".equals(bezugArt)) && nach != null) {
            String von = text(alt, "eltern_name");
            String kz = text(neu, "eltern_kurzzeichen");
            return was + " verschoben: " + (von == null ? "" : von + " → ") + nach + (kz == null ? "" : " (" + kz + ")");
        }
        return was + " verschoben" + zielZusatz(neu);
    }

    private static String zielZusatz(JsonNode neu) {
        return zusatz(text(neu, "kennzeichen"));
    }

    private static String groesse(JsonNode neu) {
        String g = text(neu, "groesse");
        String r = text(neu, "richtung");
        if (g == null) {
            return "";
        }
        return ": " + (r == null ? g : g + " · " + r);
    }

    /** „: Hauptzähler“ bzw. „: Unterzähler von MS-01“ — die Wörter des Vertrags. */
    private static String stellung(JsonNode neu) {
        String s = text(neu, "stellung");
        String bezug = text(neu, "unterzaehler_von");
        if (s == null) {
            return "";
        }
        return ": " + (bezug == null ? s : s + " von " + bezug);
    }

    /** „: Z-5b · Wirkenergie · Bezug (führend)“ — Gerät, Größe, Richtung, Rolle. */
    private static String quelle(JsonNode neu) {
        String einbau = text(neu, "einbau");
        String g = text(neu, "groesse");
        String r = text(neu, "richtung");
        String rolle = text(neu, "rolle");
        List<String> teile = new ArrayList<>();
        if (einbau != null) {
            teile.add(einbau);
        }
        if (g != null) {
            teile.add(g);
        }
        if (r != null) {
            teile.add(r);
        }
        if (teile.isEmpty()) {
            return "";
        }
        return ": " + String.join(" · ", teile) + (rolle == null ? "" : " (" + rolle(rolle) + ")");
    }

    /** „: Wandler 150/5 A (Z-5a)“ — der lesbare Wert steht als Fakt im Eintrag. */
    private static String einstellung(JsonNode alt, JsonNode neu) {
        String wert = text(neu, "wert_text");
        String einbau = text(neu, "einbau");
        String vorher = text(alt, "wert_text");
        String kopf = wert == null ? "" : ": " + (vorher == null ? wert : vorher + " → " + wert);
        return kopf + (einbau == null ? "" : (kopf.isEmpty() ? ": " : " ") + "(" + einbau + ")");
    }

    private static String wechsel(String vorher, String nachher, String einheit) {
        if (vorher == null && nachher == null) {
            return "";
        }
        if (vorher == null) {
            return ": " + nachher + einheit;
        }
        if (nachher == null) {
            return ": von " + vorher + einheit;
        }
        return ": " + vorher + einheit + " → " + nachher + einheit;
    }

    /** Die Kennzeichen der Prozesse ab dem Tag — „keine“, wenn die Liste leer ist (AP-10 IP-7). */
    private static String prozesse(JsonNode neu) {
        if (neu == null || !neu.isObject() || !neu.path("prozesse").isArray()) {
            return "";
        }
        java.util.List<String> kennzeichen = new java.util.ArrayList<>();
        neu.path("prozesse").forEach(p -> kennzeichen.add(p.asText()));
        return zusatz(kennzeichen.isEmpty() ? "keine" : String.join(", ", kennzeichen));
    }

    /** „: 70 % 4100, 30 % 4200“ — oder „: nicht verteilt“, nie „0 %“ (AP-10 IP-8). */
    private static String anteile(JsonNode neu) {
        if (neu == null || !neu.isObject() || !neu.path("zeilen").isArray()) {
            return "";
        }
        java.util.List<String> teile = new java.util.ArrayList<>();
        neu.path("zeilen").forEach(z -> teile.add(z.path("anteil_prozent").asText().replace('.', ',')
                + "\u00a0% " + z.path("kostenstelle").asText()));
        return zusatz(teile.isEmpty() ? VerteilungRegeln.NICHT_VERTEILT : String.join(", ", teile));
    }

    /** „3.100“ — eine ganze Zahl mit dem Tausenderpunkt des Portals (de-DE); alles andere bleibt, wie es ist. */
    private static String ganzzahl(String wert) {
        if (wert == null || !wert.matches("-?\\d+")) {
            return wert;
        }
        return NumberFormat.getIntegerInstance(Locale.GERMANY).format(Long.parseLong(wert));
    }

    private static String zusatz(String wert) {
        return wert == null ? "" : ": " + wert;
    }

    /** Der Textwert eines Feldes — {@code null}, wenn es fehlt oder leer ist. */
    private static String text(JsonNode knoten, String feld) {
        if (knoten == null || !knoten.isObject()) {
            return null;
        }
        JsonNode wert = knoten.get(feld);
        if (wert == null || wert.isNull()) {
            return null;
        }
        String s = wert.isValueNode() ? wert.asText() : wert.toString();
        return s.isBlank() ? null : s;
    }
}
