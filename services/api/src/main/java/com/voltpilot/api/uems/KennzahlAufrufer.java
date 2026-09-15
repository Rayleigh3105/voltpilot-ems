package com.voltpilot.api.uems;

import org.springframework.stereotype.Component;

/**
 * Wer ruft die Kennzahl-Routen auf — als Benutzer der Rechte-Ableitung (UEMS AP-11 IP-5). Seit AP-12 IP-7 fragen auch die
 * Berichts-Routen ({@link BerichtService}) hier, damit es bei EINER Naht bleibt.
 *
 * <p>Bis AP-03 IP-2 Zuweisungen je Person und Standort bringt, gibt es genau die zwei Prinzipale von
 * {@link KorrekturRechte#benutzer}: Kundenbenutzer → Kundenadministrator unternehmensweit, Plattform-Admin →
 * VoltPilot-Unterstützung. Diese Naht ist die EINE Stelle, die AP-03 IP-2 austauscht; die Tests setzen hier die
 * Personen des Referenzunternehmens ein (K18: Peter als Bearbeiter in Werk Lindach).
 */
@Component
public class KennzahlAufrufer {

    public RechteAbleitung.Benutzer benutzer(ProtokollAkteur wer) {
        return KorrekturRechte.benutzer(wer);
    }
}
