package com.voltpilot.api.uems;

import java.util.Collection;
import java.util.Set;

/** Additive Gerätegrenze; null erlaubt weiterhin Anlagen-Summen über mehrere Geräte. */
public final class SummenwertKontextRegeln {
    private SummenwertKontextRegeln() {}

    public static String grund(Set<String> erlaubt, Collection<String> gelesen) {
        return erlaubt != null && !erlaubt.containsAll(gelesen) ? "anderes_geraet" : null;
    }
}
