package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.EnergiemanagementDokumentDto;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * UEMS AP-19 IP-7: die Verzeichnis-Quellen „Dokumente“ und „Bekanntmachungen“ (VZ1, VZ2, G1; Konzept-Katalog R3).
 *
 * <p>Je freigegebene Fassung (auch abgelöste) mit Entscheidungstag bis zum Stichtag eine Zeile in der Gruppe ihrer Art:
 * Kennzeichen, Titel, Fassung, entschieden von, eingetragen von, Tag der Entscheidung; der Ort ist beim Verweis
 * „Geführt in Ihrem System: …“ mit der im Browser gebildeten Prüfsumme, beim Wortlaut „in VoltPilot“ mit der Prüfsumme
 * der Fassung — liegt das unterschriebene Original beim Kunden, „Wortlaut in VoltPilot, Original bei Ihnen: …“. Je
 * Bekanntmachung bis zum Stichtag eine Zeile in „Kompetenz und Kommunikation“ (der Kommunikationsnachweis, DK6).
 * Gelesen über {@link EnergiemanagementDokumentService} im Zaun des Aufrufers; kopiert wird nichts.
 */
@Component
@Order(10)
public class DokumentVerzeichnis implements VerzeichnisQuelle {

    /**
     * Die Gruppe je Art nach dem Zuschnitt (§3.2) und dem Konzept-Katalog; {@code verfahren} („Vorgehen“) nennt das
     * Konzept keiner Zeile zu — Lesart: zu den Grundlagen.
     */
    static final Map<String, String> GRUPPE = Map.ofEntries(
            Map.entry("energiepolitik", "grundlagen"), Map.entry("anwendungsbereich", "grundlagen"),
            Map.entry("kontext", "grundlagen"), Map.entry("rechtliche_anforderungen", "grundlagen"),
            Map.entry("verfahren", "grundlagen"), Map.entry("bestellung", "verantwortung"),
            Map.entry("risiken_chancen", "risiken_chancen"), Map.entry("kompetenz", "kompetenz_kommunikation"),
            Map.entry("kommunikation", "kompetenz_kommunikation"), Map.entry("betrieb", "betrieb_auslegung_beschaffung"),
            Map.entry("auslegung", "betrieb_auslegung_beschaffung"),
            Map.entry("beschaffung", "betrieb_auslegung_beschaffung"));
    static final String BEKANNTMACHUNG = "kompetenz_kommunikation";

    private final EnergiemanagementDokumentService dokumente;

    public DokumentVerzeichnis(EnergiemanagementDokumentService dokumente) {
        this.dokumente = dokumente;
    }

    @Override
    public List<Map<String, Object>> zeilen(LocalDate stichtag) {
        var fassungen = new ArrayList<Map<String, Object>>();
        var bekannt = new ArrayList<Map<String, Object>>();
        for (var kurz : dokumente.dokumente().dokumente()) {
            var d = dokumente.dokument(kurz.id());
            for (var f : d.fassungen()) {
                boolean freigegeben = "freigegeben".equals(f.status()) || "abgeloest".equals(f.status());
                if (freigegeben && !f.entschiedenAm().isAfter(stichtag)) {
                    fassungen.add(fassung(d, f));
                }
            }
            for (var e : d.eintraege()) {
                if ("bekannt_gemacht".equals(e.art()) && !e.am().isAfter(stichtag)) {
                    bekannt.add(zeile(d.kennzeichen(), new EnergiemanagementRegeln.VerzeichnisEingang(BEKANNTMACHUNG,
                            "bekanntmachung", d.kennzeichen(), d.titel() + ": bekannt gemacht an " + e.kreis(),
                            e.fassung(), null, e.person() == null ? null : e.person().name(), e.am().toString(), null,
                            "in_voltpilot", null)));
                }
            }
        }
        fassungen.addAll(bekannt);
        return fassungen;
    }

    private static Map<String, Object> fassung(EnergiemanagementDokumentDto.Dokument d,
            EnergiemanagementDokumentDto.Fassung f) {
        String ort;
        String ablage;
        String pruefsumme;
        if (f.verweis() != null) {
            ort = "verweis";
            ablage = f.verweis().ablage();
            pruefsumme = f.verweis().sha256();
        } else {
            ort = d.beleg() == null ? "in_voltpilot" : "wortlaut_original_beim_kunden";
            ablage = d.beleg() == null ? null : d.beleg().ablage();
            pruefsumme = f.pruefsumme();
        }
        return zeile(d.kennzeichen(), new EnergiemanagementRegeln.VerzeichnisEingang(GRUPPE.get(d.art()), d.art(),
                d.kennzeichen(), d.titel(), f.nr(), f.entschiedenVon() == null ? null : f.entschiedenVon().name(),
                f.freigabe() == null ? null : f.freigabe().akteur().name(), f.entschiedenAm().toString(), pruefsumme,
                ort, ablage));
    }

    private static Map<String, Object> zeile(String kennzeichen, EnergiemanagementRegeln.VerzeichnisEingang e) {
        Map<String, Object> zeile = EnergiemanagementRegeln.verzeichnisZeile(e);
        if (zeile.containsKey("fehler")) {
            throw new IllegalStateException("Verzeichnis-Zeile von " + kennzeichen + ": " + zeile.get("fehler"));
        }
        return zeile;
    }
}
