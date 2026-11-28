package com.voltpilot.api.consumers;

import java.util.Set;

/**
 * Die EINE Stelle, die festlegt, ob ein Handeingriff Mindestlauf und Mindestpause eines Verbrauchers überspringt
 * (vp-schalten-3s, Captain-Entscheid C vom 28.11.2026).
 *
 * <p>Einfache Lasten - Heizstab, ein Shelly-Relais oder eine Steckdose mit einer ohmschen Last ({@code generic-load})
 * - schalten von Hand in BEIDE Richtungen sofort: wer tippt, will es jetzt, und ein Heizwiderstand nimmt das
 * Schalten nicht übel. Die Schutzzeiten bleiben für die Automatik und für jedes empfindliche Gerät: Wärmepumpe,
 * Klimaanlage, alles mit Verdichter oder Motor ({@code heat-pump-sgready}, {@code pump}), Wallbox und Ladepunkt, die
 * eigenen Modbus-Geräte - und für jeden Typ, den diese Liste nicht kennt. Im Zweifel hält die Schutzzeit.
 *
 * <p>Die Box rät das nie aus dem Typnamen: der Registry-Push trägt die Erklärung als
 * {@code guards.limits.manual_skips_min_times} ({@code EntityRegistryService#mergeCycleLimits}), und nur dort, wo das
 * Profil Mindestzeiten setzt. Eine Box vor dieser Fassung überliest das Feld und hält weiter wie bisher; das Portal
 * nennt dann, ab wann geschaltet wird.
 */
public final class HandeingriffSchutzzeiten {

    private HandeingriffSchutzzeiten() {
    }

    /** Die Gerätetypen (Entitätskatalog), deren Handeingriff sofort schaltet. */
    static final Set<String> EINFACHE_LASTEN = Set.of("heating-rod", "generic-load");

    /** Ob ein Handeingriff an diesem Gerätetyp Mindestlauf und Mindestpause überspringt. */
    public static boolean sofort(String entityType) {
        return entityType != null && EINFACHE_LASTEN.contains(entityType);
    }
}
