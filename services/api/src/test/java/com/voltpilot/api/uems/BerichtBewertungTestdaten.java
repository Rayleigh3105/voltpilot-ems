package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

/** Kleiner eingefrorener AP-16-Abzug für die reinen PDF-/CSV-Tests. */
final class BerichtBewertungTestdaten {
    private BerichtBewertungTestdaten() {}

    static ObjectNode aus(JsonNode bestand) {
        ObjectNode abzug = ((ObjectNode) bestand).objectNode();
        ObjectNode kopf = ((ObjectNode) bestand.path("kopf")).deepCopy();
        abzug.set("kopf", kopf);
        kopf.put("bericht", "BW-2026-0001").put("vorlage", BerichtRegeln.ENERGETISCHE_BEWERTUNG)
                .put("vorlage_fassung", 1).put("unternehmen", "Kunststoffwerk Ahrenberg GmbH");
        ((ObjectNode) kopf.path("geltung")).put("art", BerichtRegeln.UNTERNEHMEN).put("kennzeichen", "U")
                .put("name_zum_datenstand", "Kunststoffwerk Ahrenberg GmbH");
        ((ObjectNode) kopf.path("zeitraum")).put("art", BerichtRegeln.DATENGRUNDLAGE).put("schluessel", "2026-10")
                .put("von", "2026-10-01T00:00:00+02:00").put("bis", "2026-11-01T00:00:00+01:00");
        kopf.putArray("vergleichszeitraeume");
        kopf.putArray("quellenverzeichnis").add("Umfang").add("EE-1").add("MB-1").add("G-1");

        abzug.putObject("umfang").put("id", "10000000-0000-0000-0000-000000000001").put("fassung", 3)
                .put("von", "2026-10-01").put("bis", "2026-10-31").put("teilansicht", false);

        ObjectNode rangliste = abzug.putObject("rangliste");
        rangliste.putObject("kriterien").put("fassung", 2);
        rangliste.putObject("nenner").put("wert", "185380").put("einheit", "kWh").put("vorhanden", 3)
                .put("gesamt", 3).put("anlagen", "3 von 3 Anlagen").put("zustand", "vollständig");
        rangliste.put("zugeordnet", "125740").put("rest", "59640").put("abdeckung_prozent", "67.8");
        ObjectNode ee = rangliste.putArray("einsaetze").addObject();
        ee.put("id", "20000000-0000-0000-0000-000000000001").put("kennzeichen", "EE-1")
                .put("name", "Spritzguss").put("traeger", "Strom").put("menge", "77480").put("einheit", "kWh")
                .put("zustand", "vollständig").put("anteil_prozent", "41.8").put("rang", 1)
                .put("vorschlag", "über Schwelle");
        rangliste.putArray("weitere_traeger");

        ObjectNode einstufung = abzug.putArray("einstufungen").addObject();
        einstufung.put("einsatz_id", ee.path("id").asText()).put("einsatz", "EE-1")
                .put("name_zum_datenstand", "Spritzguss").put("fassung", 4).put("einstufung", "wesentlich")
                .put("gueltig_ab", "2026-11-06").put("person", "Ines Kaltenbach")
                .put("begruendung", "Größter Einsatz an beiden Hallen.");

        ObjectNode abdeckung = abzug.putObject("messabdeckung");
        abdeckung.putObject("summe").set("nenner", rangliste.path("nenner").deepCopy());
        ((ObjectNode) abdeckung.path("summe")).put("gemessen_zugeordnet", "125740")
                .put("abdeckung_prozent", "67.8").put("k8", "nicht_belastbar").put("ersatz", "0")
                .put("ungemessen", "59640").put("ungemessen_prozent", "32.2");
        ObjectNode je = abdeckung.putArray("je_einsatz").addObject();
        je.put("kennzeichen", "EE-1").put("name", "Spritzguss").put("traeger", "Strom")
                .put("menge", "77480").put("einheit", "kWh");
        je.putArray("gemessen").addObject().put("kennzeichen", "MS-06");
        je.putArray("geplant").addObject().put("kennzeichen", "MS-23");
        je.putArray("ersatz");
        je.putArray("ungemessen").addObject().put("anlage", "Halle 1");

        ObjectNode plan = abzug.putArray("messplanung").addObject();
        plan.put("kennzeichen", "MB-1").put("einsatz_id", ee.path("id").asText())
                .put("wortlaut", "Lüftung, Beleuchtung und Allgemeinstrom Halle 1").put("ort", "Halle 1")
                .put("groesse", "Wirkenergie").put("frist", "2027-03-31").put("zustand", "eingeloest")
                .put("messstelle", "MS-23").put("begruendung", "Messstelle eingerichtet")
                .put("datenstand", "2026-11-17T10:00:00+01:00");

        ObjectNode mittel = abzug.putArray("messmittel").addObject();
        mittel.put("geraet", "G-1").put("einbau", "Netzzähler Halle 1").put("genauigkeitsklasse", "B")
                .put("pruefungsart", "mid_konformitaet").put("pruefung_am", "2023-06-14")
                .put("pruefung_gueltig_bis", "2031-12-31");
        mittel.putObject("beleg").put("bezeichnung", "Zählerstandsmitteilung 10/2026").put("ablage", "DMS-9")
                .put("sha256", "3b1f" + "0".repeat(60));

        abzug.putObject("qualitaet").put("abdeckung_min_prozent", 67.8).put("luecken", 1)
                .put("ersatzwerte", 0).put("korrekturen_im_zeitraum", 0).put("vorlaeufig", 0);
        return abzug;
    }
}
