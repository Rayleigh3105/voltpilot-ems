-- AP-03 IP-14: nur das Protokollvokabular erweitern; keine Bestandszeile ändern.
CREATE OR REPLACE FUNCTION zugriff_vokabular()
RETURNS TABLE (vokabular TEXT, nr INTEGER, wort TEXT)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    ('konto', 1, 'benutzer'),
    ('konto', 2, 'partner'),
    ('konto', 3, 'plattform'),
    ('konto_zustand', 1, 'angelegt'),
    ('konto_zustand', 2, 'aktiv'),
    ('konto_zustand', 3, 'gesperrt'),
    ('konto_zustand', 4, 'entfernt'),
    ('art', 1, 'installateur'),
    ('art', 2, 'voltpilot'),
    ('art', 3, 'notfall'),
    ('umfang', 1, 'ansehen'),
    ('umfang', 2, 'einrichten'),
    ('umfang', 3, 'einrichten_und_bedienen'),
    ('aenderung', 1, 'zuweisen'),
    ('aenderung', 2, 'entziehen'),
    ('aenderung', 3, 'sperren'),
    ('aenderung', 4, 'entfernen'),
    ('aenderung', 5, 'verlaengern'),
    ('aenderung', 6, 'ablaufen'),
    ('aenderung', 7, 'erste_anmeldung'),
    ('aenderung', 8, 'startpasswort_neu')
$$;
