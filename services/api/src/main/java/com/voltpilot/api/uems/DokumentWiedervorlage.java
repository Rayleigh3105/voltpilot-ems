package com.voltpilot.api.uems;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * UEMS AP-19 IP-21 (WV1, DK5): die Wiedervorlage-Quelle „Dokumente“ — je Dokument mit Überprüfung eine Frist, so wie
 * die Dokument-Liste sie beim Abruf ableitet ({@link EnergiemanagementDokumentService#dokumente}: gültige Fassung,
 * jüngere von Freigabe und „geprüft, bleibt“ + Monate). Ein Nachweis ohne Überprüfung, ein Dokument ohne freigegebene
 * Fassung und ein aufgehobenes tragen keine Frist — und damit keine Zeile.
 */
@Component
@Order(10)
public class DokumentWiedervorlage implements WiedervorlageQuelle {

    private final EnergiemanagementDokumentService dokumente;

    public DokumentWiedervorlage(EnergiemanagementDokumentService dokumente) {
        this.dokumente = dokumente;
    }

    @Override
    public List<Frist> fristen(LocalDate abruf) {
        var aus = new ArrayList<Frist>();
        for (var d : dokumente.dokumente().dokumente()) {
            var u = d.ueberpruefung();
            if (u == null || u.faelligAm() == null) continue;
            aus.add(new Frist("dokument_ueberpruefung", d.kennzeichen(), d.titel() + " — Überprüfung", u.faelligAm(),
                    null, d.id(), null));
        }
        return aus;
    }
}
