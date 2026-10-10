package com.voltpilot.api.uems;

import com.voltpilot.api.web.dto.InternesAuditDto;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * UEMS AP-19 IP-18: die Verzeichnis-Quelle „Audits“ — je abgeschlossenes internes Audit bis zum Stichtag eine Zeile der
 * Gruppe {@code audits_feststellungen} („Interne Audits und Feststellungen“): Art {@code internes_audit}, Kennzeichen
 * AU-…, Titel, entschieden von (die Person des Abschlusses), eingetragen von (das Konto), Tag = abgeschlossen am,
 * Prüfsumme der Kopie. Der Ort ist mit Bericht-Verweis „Wortlaut in VoltPilot, Original bei Ihnen: …“ (der
 * unterschriebene Bericht bleibt beim Kunden, IA5), ohne ihn „in VoltPilot“ (R9: AU-2029-0001 am 31.01.2029).
 * Geplante, durchgeführte und abgesagte Audits sind kein Nachweis. Gelesen über {@link InternesAuditService#programm}
 * — mit dem Zaun des Aufrufers.
 */
@Component
@Order(90)
public class AuditVerzeichnis implements VerzeichnisQuelle {

    static final String GRUPPE = "audits_feststellungen";

    private final InternesAuditService audits;

    public AuditVerzeichnis(InternesAuditService audits) {
        this.audits = audits;
    }

    @Override
    public List<Map<String, Object>> zeilen(LocalDate stichtag) {
        var aus = new ArrayList<Map<String, Object>>();
        for (var a : audits.programm(stichtag).audits()) {
            var abschluss = a.abschluss();
            if (abschluss != null && !abschluss.am().isAfter(stichtag)) {
                aus.add(zeile(a, abschluss));
            }
        }
        return aus;
    }

    private static Map<String, Object> zeile(InternesAuditDto.Audit a, InternesAuditDto.Abschluss abschluss) {
        var bericht = abschluss.bericht();
        Map<String, Object> zeile = EnergiemanagementRegeln.verzeichnisZeile(new EnergiemanagementRegeln.VerzeichnisEingang(
                GRUPPE, "internes_audit", a.kennzeichen(), a.titel(), null,
                abschluss.entschiedenVon() == null ? null : abschluss.entschiedenVon().name(),
                abschluss.eingetragen().akteur().name(), abschluss.am().toString(), abschluss.pruefsumme(),
                bericht == null ? "in_voltpilot" : "wortlaut_original_beim_kunden",
                bericht == null ? null : bericht.ablage()));
        if (zeile.containsKey("fehler")) {
            throw new IllegalStateException("Verzeichnis-Zeile des Audits " + a.kennzeichen() + ": " + zeile.get("fehler"));
        }
        return zeile;
    }
}
