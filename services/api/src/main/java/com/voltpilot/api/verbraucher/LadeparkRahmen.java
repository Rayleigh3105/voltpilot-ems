package com.voltpilot.api.verbraucher;

import com.voltpilot.api.web.dto.SiteChargingDto.ChargingBudgetDto;
import com.voltpilot.api.web.dto.VerbraucherDto.Rahmen;

/**
 * Der LADEPARK-RAHMEN als Kopf des Ladepunkt-Abschnitts (Konzept
 * {@code vp-verbrauchsmgmt-konzept-v1} §4.2).
 *
 * <p><b>Rein und alles-durchgereicht.</b> Es entsteht keine neue Zahl: der
 * Rahmen ist eine Auswahl aus dem Budget-Block, den die Box ohnehin meldet,
 * plus die im Portal gepflegte Anschlussgrenze. Ihn hier EINMAL zu projizieren
 * spart der Flaeche einen zweiten Abruf und haelt die Quelle bei EINER Tabelle
 * ({@code device_charging_budget}).
 *
 * <p><b>⚠ Ohne gemeldetes Budget gibt es KEINEN Rahmen aus dem Nichts.</b> Eine
 * Anlage, die eine Grenze gepflegt hat, deren Box sich aber nie gemeldet hat,
 * bekommt trotzdem einen Rahmen - aber nur mit dieser einen Zahl; alles andere
 * bleibt {@code null} („nicht gemessen"), nie 0.
 */
public final class LadeparkRahmen {

    private LadeparkRahmen() {}

    /**
     * @param budget            der Budget-Block der Box; {@code null} = sie hat
     *                          sich nie gemeldet
     * @param gepflegteGrenzeKw {@code site_charging_config.grid_limit_kw}
     * @return der Rahmen, oder {@code null}, wenn es zu ihm nichts zu sagen gibt
     */
    public static Rahmen aus(ChargingBudgetDto budget, Double gepflegteGrenzeKw) {
        if (budget == null) {
            if (gepflegteGrenzeKw == null) {
                return null;
            }
            return new Rahmen(null, gepflegteGrenzeKw, null, null, null, null, null, null, null,
                    null, false, null, 0, null);
        }
        return new Rahmen(budget.gridLimitKw(), gepflegteGrenzeKw, budget.effLimitKw(),
                budget.siteLoadKw(), budget.maxHouseLoadKw(), budget.allocatedKw(),
                budget.budgetKw(), budget.marginPct(), budget.minPowerKw(), budget.budgetMode(),
                budget.budgetBlind(), budget.budgetNote(), budget.connectorCount(),
                budget.reportedAt());
    }
}
