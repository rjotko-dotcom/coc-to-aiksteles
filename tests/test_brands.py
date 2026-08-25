"""Skirtingų gamintojų ir kalbų liudijimai.

Tekstas perrašytas iš tikrų atitikties liudijimų: Hyundai (dviejų pusių,
trijų stulpelių forma) ir Citroën (prancūziška forma).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.coc_extract import parse_coc_text  # noqa: E402

HYUNDAI_KONA = """
Part 1
The undersigned M. KNOPIK
Position GENERAL MANAGER
hereby certifies that the vehicle :
0.1. Make (Trade name of manufacturer) : Hyundai
0.2. Type : OSE
- Variant : F5E11
- Version : E11B11
0.2.1. Commercial name(s) : Kona, Kauai
0.2.3. Identifiers :
0.2.3.1. Interpolation family's identifier : IP-041230-TMA-1
0.2.3.4. Roadload family's identifier : RL-041230-TMA-1
0.4. Vehicle category : M1
0.5. Company name and address of manufacturer :
Hyundai Motor Manufacturing Czech s.r.o.,
0.6. Location and method of attachment of the statutory plates :
On the left hand B-post, bonded
Location of the vehicle identification number :
Under the right front seat
0.10. Vehicle identification number : TMAJ38157KJ000003
0.11. Date of manufacture of the vehicle : 10.12.2020
conforms in all respects to the type described in
approval e4*2007/46*1522*01
granted on 12.11.2020 and
can be permanently registered in Member States having left hand traffic
40. Colour of vehicle : white
"""

HYUNDAI_STAREX = """
COMPLETE VEHICLES
EEC CERTIFICATE OF CONFORMITY
0.1. Make (Trade name of manufacture) : Hyundai
0.2. Type : TQ
variant : V3D72
version : M53AZ1
0.2.1. Commercial name : H-1,STAREX,GRAND STAREX
0.4. Vehicle Category : N1
0.5. Name and address of the manufacturer :
Hyundai Motor Company 231,Yangjae-dong,
0.6. Location and method of attachment of the statutory plates :
On the left-hand B-post
Location of the vehicle identification number :
Under the right front seat
0.10. Vehicle identification number :
conforms in all respects to the type described in
approval e4*2007/46*0091*04
issued on 06.05.2011 and
40. Colour of vehicle : white
"""

CITROEN = """
CERTIFICAT DE CONFORMITE EUROPEEN
VEHICULES COMPLETS
0.1. Marque (dénomination commerciale du constructeur) : CITROEN
0.2. Type : Y
Variante : CTMFC
Version : HY
0.2.1. Appellation(s) commerciale(s) : RELAY
0.4. Catégorie de véhicule : N1
0.5. Raison sociale et adresse du constructeur : AUTOMOBILES CITROEN
0.6. Emplacement et méthode de fixation des plaques réglementaires :
TABLIER COMPARTIMENT MOTEUR - rivetée
Emplacement du numéro d'identification du véhicule :
PASSAGE DE ROUE AVANT DROIT DANS HABITACLE
0.10. Numéro d'identification du véhicule : VF7YCTMF012000004
0.11. Date de construction du véhicule : 30/07/2015
est conforme à tous égards au type décrit dans la réception e3*2007/46*0046*10
délivrée le 04/02/2014 et peut être immatriculé à titre permanent
40. Couleur du véhicule : blanc
"""


def test_hyundai_kona():
    data = parse_coc_text(HYUNDAI_KONA)
    assert data.make == "Hyundai"
    assert data.type_variant_version == "OSE/F5E11/E11B11"
    assert data.commercial_name == "Kona, Kauai"
    assert data.vin == "TMAJ38157KJ000003"
    assert data.category == "M1"
    assert data.approval_number == "e4*2007/46*1522*01"
    assert data.approval_date == "12.11.2020"
    assert data.manufacture_date == "10.12.2020"
    assert data.colour == "BALTA"


def test_hyundai_starex_with_issued_on():
    """Antroje Hyundai pusėje data pažymėta „issued on“, o ne „granted on“."""
    data = parse_coc_text(HYUNDAI_STAREX)
    assert data.make == "Hyundai"
    assert data.type_variant_version == "TQ/V3D72/M53AZ1"
    assert data.commercial_name == "H-1,STAREX,GRAND STAREX"
    assert data.category == "N1"
    assert data.approval_number == "e4*2007/46*0091*04"
    assert data.approval_date == "06.05.2011"
    assert data.colour == "BALTA"
    # VIN liudijime neįrašytas – ir tikrai neturi būti paimta žymens vieta
    assert data.vin == ""
    assert any("identifikavimo numeris" in w.lower() for w in data.warnings)


def test_citroen_in_french():
    data = parse_coc_text(CITROEN)
    assert data.make == "CITROEN"
    assert data.type_variant_version == "Y/CTMFC/HY"
    assert data.commercial_name == "RELAY"
    assert data.vin == "VF7YCTMF012000004"
    assert data.category == "N1"
    assert data.approval_number == "e3*2007/46*0046*10"
    assert data.approval_date == "04.02.2014"
    assert data.manufacture_date == "30.07.2015"
    assert data.colour == "BALTA"


def test_location_of_vin_is_not_mistaken_for_the_vin():
    for text in (HYUNDAI_KONA, CITROEN):
        data = parse_coc_text(text)
        assert "front seat" not in data.vin
        assert "PASSAGE" not in data.vin
