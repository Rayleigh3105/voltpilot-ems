package com.voltpilot.api.uems;

import java.time.LocalDate;
import java.util.List;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * UEMS AP-19 IP-21 (WV1, IA4): die Wiedervorlage-Quelle „internes Audit“ — das nächste Audit, wie das Auditprogramm
 * es beim Abruf ableitet ({@link InternesAuditService#programm}: letzter Durchführungstag bis zum Abruf + Rhythmus).
 * Ohne durchgeführtes Audit gibt es keine Frist und keine Zeile (kein erfundener Beginn). Kennzeichen und Verantwortlich
 * sind die des Audits, an dessen Durchführung die Frist hängt — das nächste hat noch keins.
 */
@Component
@Order(20)
public class AuditWiedervorlage implements WiedervorlageQuelle {

    private final InternesAuditService audits;

    public AuditWiedervorlage(InternesAuditService audits) {
        this.audits = audits;
    }

    @Override
    public List<Frist> fristen(LocalDate abruf) {
        var programm = audits.programm(abruf);
        var naechstes = programm.naechstes();
        if (naechstes.faelligAm() == null) return List.of();
        return programm.audits().stream().filter(a -> naechstes.basis().equals(a.durchgefuehrtAm())).findFirst()
                .map(a -> List.of(new Frist("internes_audit", a.kennzeichen(), "Nächstes internes Audit",
                        naechstes.faelligAm(), a.verantwortlich() == null ? null : a.verantwortlich().name(), a.id(),
                        null)))
                .orElse(List.of());
    }
}
