package com.voltpilot.api.uems;

import java.util.List;

/**
 * Die Messstellen, die an Orten des Ortsbaums hängen — für die Sperrgründe beim
 * Archivieren (E12: „nur ohne aktive Anlagen UND Messstellen", {@code MESSSTELLE_AKTIV} in
 * {@link OrtsbaumAbleitung#archivieren}).
 *
 * <p><b>Der Haken für AP-04 IP-7.</b> Heute hängt keine Messstelle an einem Ort — die
 * Zuordnung Messstelle → Ort bringt erst IP-7. Bis dahin liefert {@link Keine} eine leere
 * Liste, und die Sperre kennt nur aktive ANLAGEN. IP-7 ersetzt diese Bean durch eine, die
 * die Messstellen mit ihren Ort-Intervallen liest — die Kennzeichen der Orte sind dabei die
 * Kurzzeichen (dieselben Schlüssel, die {@code StandortService} in den Baum legt). Keine
 * Prüflogik wandert dafür: die Sperre urteilt weiter {@link OrtsbaumAbleitung}.
 */
public interface OrtsbaumMessstellen {

    /**
     * Die Messstellen des Kundenbereichs (unter RLS) mit Zustand und Ort-Intervallen; die
     * Eltern der Intervalle sind Kurzzeichen der Orte bzw. {@link OrtsbaumAbleitung#UNTERNEHMEN}.
     */
    List<OrtsbaumAbleitung.Messstelle> messstellen();

    /** Bis AP-04 IP-7: keine Messstelle hängt an einem Ort. */
    final class Keine implements OrtsbaumMessstellen {

        @Override
        public List<OrtsbaumAbleitung.Messstelle> messstellen() {
            return List.of();
        }
    }
}
