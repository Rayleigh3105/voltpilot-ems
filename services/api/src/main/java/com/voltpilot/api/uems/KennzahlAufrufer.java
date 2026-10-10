package com.voltpilot.api.uems;

import org.springframework.stereotype.Component;

/**
 * Wer ruft die Kennzahl-Routen auf — als Benutzer der Rechte-Ableitung (UEMS AP-11 IP-5). Seit AP-12 IP-7 fragen auch die
 * Berichts-Routen ({@link BerichtService}) hier, damit es bei EINER Naht bleibt.
 *
 * <p>Seit AP-03 IP-6 ist der Aufrufer der aus dem Zugriff-Kontext ({@link KorrekturRechte#aufrufer}): die wirksamen
 * Zuweisungen je Person und Standort, ein nie zugewiesenes Kundenkonto als Kundenadministrator (E12), eine angenommene
 * Unterstützung als Unterstützer. Ohne Kontext und am Plattform-Umschalter bleibt es bei den zwei Prinzipalen von
 * {@link KorrekturRechte#benutzer}: Kundenbenutzer → Kundenadministrator unternehmensweit, Plattform-Admin →
 * VoltPilot-Unterstützung. Die Tests setzen hier die Personen des Referenzunternehmens ein (K18: Peter als Bearbeiter in
 * Werk Lindach).
 */
@Component
public class KennzahlAufrufer {

    public RechteAbleitung.Benutzer benutzer(ProtokollAkteur wer) {
        return KorrekturRechte.aufrufer(wer);
    }
}
