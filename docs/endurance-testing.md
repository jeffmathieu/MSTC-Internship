# 24h-optimalisatie en offline testen

## Wat is veranderd?

- Het volledige JSONL-archief blijft behouden, ook boven 20.000 records en na een herstart. CSV is een afgeleide export; een CSV-fout veroorzaakt geen dubbele JSONL-ronde.
- Rondegegevens en statistieken worden per auto geïndexeerd en gecachet. Een nieuwe ronde maakt alleen de gegevens van de betrokken auto opnieuw ongeldig. Conditiefilters hergebruiken die indexen.
- Dashboardvensters ontvangen alleen hun eigen rondegegevens en relevante samenvattingen. Grafiekvensters ontvangen de relevante klasse. Volgende updates bevatten gewijzigde ronde-/highlight-suffixen, geen volledige historie.
- De lapbalk tekent alleen zichtbare regels plus een kleine buffer. Grafieken tekenen het zichtbare bereik met een begrensd aantal punten, met behoud van minima/maxima. Zoomen onthult de onderliggende details; het archief wordt niet uitgedund.
- PDF-berekeningen en Python-rendering lopen in één aparte worker tegelijk. Afgeleide snapshots worden asynchroon samengevoegd en atomair vervangen; kritieke ronde- en pit-eventlogs worden vóór publicatie weggeschreven. Ook PDF-bestanden worden pas na succesvolle generatie vervangen.
- Een stabiele `lapId` maakt handmatige correcties onafhankelijk van ontbrekende rondetellers. Identieke opeenvolgende rondetijden met verschillende expliciete rondetellers blijven bewaard.

## Timingherkenning en pitstops

De Zolder-kopie bevat een onbenoemde statuskolom, `PIT TIME`, `#PIT` en een wisselende `GAP`. De GAP-cellen kunnen onafhankelijk wisselen: één tabel kan tegelijk `-- 581 laps --` en `16.427` bevatten. De leider blijft rondes tonen.

De adapter herkent deze combinatie op basis van schema én inhoud, onthoudt tellers afzonderlijk en behandelt bevestigde tijdwaarden als intervallen naar de auto erboven. Rondetellers worden nooit tot gap-seconden omgerekend. Bij twijfel blijft een waarde onbekend. Tabellen met aparte LAPS/INT/DIFF blijven op hun bestaande route; gewone lapachterstanden zoals `1L` blijven behouden.

Fuel (`F` of ETA `Fuel`) en pit (`P` of `In pit`) krijgen afzonderlijke timers plus een totaal. Geen waargenomen fuel bij een volledig gevolgde stop betekent fuel `0:00`. Een gemiste observatie/restart tijdens een stop kan de tijd onbekend maken. Timers hebben de precisie van het ingestelde pollinterval, geen officiële meetlusprecisie.

`PIT TIME` is tijdens de stop een lopende klok. Alleen de waarneming na vertrek geldt als definitieve providerduur. Late duur-/counterupdates worden aan hetzelfde event gekoppeld. Driver change heeft drie waarden: yes, no, unknown.

Oude archieven worden alleen bij het lezen geïnterpreteerd: `raw.PIT TIME` kan alsnog worden benut. Ontbrekende exacte fueltijden zijn niet betrouwbaar te reconstrueren uit een log met uitsluitend rondepassages. Ontbrekende officiële rondegetallen worden als **waargenomen rondevolgorde** weergegeven (`~` / “observed laps”), niet als verzonnen officiële racelaps. Bestaande, verkeerd berekende cumulatieve gaps uit de bewezen wisselkolom worden uit nieuwe rapporten geweerd.

## Zelf testen met de racekopie

Voer vanuit de projectmap uit, met de projectafhankelijkheden geïnstalleerd:

```sh
npm run replay -- "race kopie"
```

Dit opent het echte dashboard met alle 12.568 records uit de kopie. De bronmap, normale appinstellingen en bestaande PDF's blijven ongewijzigd. Er wordt geen timingwebsite geopend. Afgeleide bestanden/proefrapporten gaan naar een nieuwe tijdelijke map, waarvan het pad in de terminal staat.

- Scroll direct naar oude rondes, ook terwijl het dashboard iedere 5 seconden ververst.
- Open de grafieken; zoom, verschuif het bereik en wissel grafiektype en conditiefilter.
- Stop pauzeert de herhaalde updates; Start hervat ze. Deze teststand verzint geen extra historische rondes en reconstrueert geen fuel-overgangen tussen ontbrekende polls.
- De exportknop in het debuggedeelte maakt een proef-PDF in de tijdelijke map. Handmatige rondewijzigingen zijn in deze alleen-lezen teststand uitgeschakeld.
- Test dit op de teamlaptop met dezelfde vensters, schermgrootte en overige programma's die tijdens de race gebruikt worden. Laat dit bijvoorbeeld een uur draaien; let op responsiviteit én oplopend geheugen.

## Geautomatiseerde controles

```sh
npm test
npm run test:24h
npm run test:ui
npm run replay -- "race kopie" --smoke
```

`test:24h` simuleert 45 auto's, 17.281 pollmomenten en 31.095 opgeslagen rondes. Opslag en timers lopen op alle pollmomenten; de eerste fase controleert afgeleide analytics elk uur. Vervolgens worden 120 opeenvolgende volledige live updates uitgevoerd tegen het volle archief, met twee nieuwe autorondes per poll. Herstart, historische correcties, IPC-patches en grafiekdatasets worden eveneens getest. Dit is een versnelde data-/belastingtest, **geen 24 uur durende wall-clock- of hardwaregarantie**.

Gemeten op deze ontwikkelmachine (september 2026; indicatief):

| Controle | Resultaat |
| --- | --- |
| Echte racekopie | 12.568 records, 38 auto's met opgeslagen rondes; wisselkolom herkend |
| Echte kopie: herhaalde berekening / scroll | circa 20 ms / 2,5–18 ms over meerdere runs; 20 getekende regels onderaan |
| Synthetische 24h-UI: scroll / zoom | circa 5 ms / 8 ms |
| Dashboardupdate zonder nieuwe ronde | maximaal circa 67 kB per venster |
| Vol archief + nieuwe rondes, 120 updates | mediaan 226 ms; 95e percentiel 332 ms; maximum 1,77 s inclusief koude herstart |
| Proef-PDF uit echte kopie | 16 pagina's, 8 driverstints, 18 geregistreerde stopnummers; ontbrekende gegevens expliciet onbekend |

De laatste bugcontrole was gericht op deze datastroom: wisselkolommen, ontbrekende/late pitgegevens, driverwissels, herstart/deduplicatie, handmatige correcties, IPC en grafiekresponsiviteit. Dit is geen claim dat alle mogelijke bugs in de gehele app zijn uitgesloten.
# Fuel estimates and net driver time

Pitstop setup now contains a per-car **Enable fuel estimates** switch (off by default).
When off, estimated level, refuel advice and fuel warnings are hidden; measured
fuel/pit service timers remain independent. Capacity, consumption in litres per
observed completed lap, reserve, optional fuel flow, planned pit horizon and next
stint length are configurable. Calibrate the current tank level to start. Confirm
the actual total litres after leaving the pits to replace that stop's timer-based
estimate, rather than adding it twice. A calibration already includes earlier stops.
Re-enabling after disabling requires a new calibration; configuration is retained.
These are estimates, not telemetry: missed laps and variable consumption reduce
accuracy. Unknown refuels hide the level until corrected or recalibrated. Fuel
settings and the accounting checkpoint survive restart.

Live driver stint time and driver totals now use net driving time: observed fuel
and pit/garage intervals are excluded, including long stops without a driver
change. PDF driver metrics use the same calculation. Older lap-only archives use
approximate service windows and are labelled estimated; they cannot recover an
unrecorded exact pit entry/exit or certify regulatory driving-time compliance.

Regression coverage: `fuelAndDriving.test.js`, `fuelStorage.test.js`, and the
offline replay `--smoke` check (real Electron calibration and enable/disable UI).
