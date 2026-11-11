"""Die Platine als Körper aus dem Maßmodell: zum Einlegen in den Entwurf,
für die Durchdringungsprüfung und für die Bilder."""
from . import massmodell as m
from .formen import aus_huelle, rundquader, zylinder

PLATINENGRUEN = "#2f7d4f"


def leiterplatte():
    platte = rundquader(0, m.PLATINE_X, 0, m.PLATINE_Y, -m.PLATINE_DICKE, 0, m.PLATINE_ECKRADIUS)
    return platte - zylinder(m.LOCH_X, m.LOCH_Y, -m.PLATINE_DICKE - 1, 1, m.LOCH_D / 2)


def bauteile(zugabe=0.0):
    """Liste (Name, Körper, Farbe) aller Hüllkörper, Leiterplatte zuerst."""
    teile = [("leiterplatte", leiterplatte(), PLATINENGRUEN)]
    teile += [(q.name, aus_huelle(q, zugabe), q.farbe) for q in m.oberseite() + m.unterseite()]
    return teile


def unterseite_huelle():
    """Raum unter der Platine bis zum gemessenen tiefsten Punkt. Wo darin
    Bauteile sitzen, ist nicht bekannt; Auflagen stehen in diesem Raum."""
    return rundquader(0, m.PLATINE_X, 0, m.PLATINE_Y, -m.PLATINE_DICKE - m.UNTERSEITE_TIEFE,
                      -m.PLATINE_DICKE, m.PLATINE_ECKRADIUS)
