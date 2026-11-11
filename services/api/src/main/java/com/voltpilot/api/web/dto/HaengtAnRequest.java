package com.voltpilot.api.web.dto;

import java.time.LocalDate;
import java.util.UUID;

/**
 * Zählerbaum-Konzept (E1 A, R5): „Wo hängt er?" beim Umhängen einer
 * Komponente. {@code haengtAn = null} hängt sie an die Wurzel (den
 * Netzanschluss).
 *
 * @param seitWann {@code schon_immer} (ersetzt den laufenden Abschnitt ab
 *     seinem eigenen Beginn, frühere Tage rechnen neu) oder {@code ab_tag}
 *     (beendet ihn am Vortag von {@code ab}, frühere Tage bleiben, wie sie
 *     waren) - das geschlossene Vokabular des Dialogs.
 * @param ab nur bei {@code ab_tag} gelesen.
 */
public record HaengtAnRequest(UUID haengtAn, String seitWann, LocalDate ab) {

    public static final String SCHON_IMMER = "schon_immer";
    public static final String AB_TAG = "ab_tag";
}
