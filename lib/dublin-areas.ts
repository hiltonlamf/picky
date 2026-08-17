/**
 * Broad, user-recognisable Dublin areas derived from Eircode routing keys.
 *
 * They deliberately do not claim a specific neighbourhood: for example, an
 * address in D06 might be Rathmines, Ranelagh, Rathgar, or Milltown. The
 * postal area is therefore a reliable guide filter while a more precise
 * neighbourhood remains optional future data.
 */
export const DUBLIN_EIRCODE_AREAS = {
  D01: { label: 'D01 · City centre north / Docklands', display: 'Dublin 1' },
  D02: { label: 'D02 · City centre south / Temple Bar / Trinity', display: 'Dublin 2' },
  D03: { label: 'D03 · Clontarf / Fairview / East Wall', display: 'Dublin 3' },
  D04: { label: 'D04 · Ballsbridge / Sandymount / Donnybrook / Ringsend', display: 'Dublin 4' },
  D05: { label: 'D05 · Raheny / Artane / Kilbarrack', display: 'Dublin 5' },
  D06: { label: 'D06 · Rathmines / Ranelagh / Rathgar / Milltown', display: 'Dublin 6' },
  D6W: { label: 'D6W · Terenure / Kimmage / Harold’s Cross / Templeogue', display: 'Dublin 6W' },
  D07: { label: 'D07 · Stoneybatter / Phibsborough / Cabra / Grangegorman', display: 'Dublin 7' },
  D08: { label: 'D08 · Liberties / Portobello / Kilmainham / Inchicore', display: 'Dublin 8' },
  D09: { label: 'D09 · Drumcondra / Whitehall / Santry / Beaumont', display: 'Dublin 9' },
  D10: { label: 'D10 · Ballyfermot / Cherry Orchard', display: 'Dublin 10' },
  D11: { label: 'D11 · Finglas / Ballymun', display: 'Dublin 11' },
  D12: { label: 'D12 · Crumlin / Drimnagh / Walkinstown', display: 'Dublin 12' },
  D13: { label: 'D13 · Howth / Sutton / Baldoyle / Donaghmede', display: 'Dublin 13' },
  D14: { label: 'D14 · Dundrum / Churchtown / Goatstown', display: 'Dublin 14' },
  D15: { label: 'D15 · Blanchardstown / Castleknock / Clonsilla', display: 'Dublin 15' },
  D16: { label: 'D16 · Rathfarnham / Ballinteer / Ballyboden / Knocklyon', display: 'Dublin 16' },
  D17: { label: 'D17 · Darndale / Priorswood / Clare Hall', display: 'Dublin 17' },
  D18: { label: 'D18 · Sandyford / Stillorgan / Leopardstown / Foxrock', display: 'Dublin 18' },
  D20: { label: 'D20 · Palmerstown / Chapelizod', display: 'Dublin 20' },
  D22: { label: 'D22 · Clondalkin', display: 'Dublin 22' },
  D24: { label: 'D24 · Tallaght / Firhouse', display: 'Dublin 24' },
} as const;

export type DublinAreaCode = keyof typeof DUBLIN_EIRCODE_AREAS;

function isDublinAreaCode(value: string): value is DublinAreaCode {
  return Object.prototype.hasOwnProperty.call(DUBLIN_EIRCODE_AREAS, value);
}

/** Extract an Eircode routing key or a conventional "Dublin 6" district. */
export function extractDublinAreaCode(address: string | null | undefined): DublinAreaCode | null {
  if (!address) return null;
  const eircode = address.toUpperCase().match(/\b(D(?:0[1-9]|1\d|2[0-4])|D6W)(?=\s*[A-Z0-9]{4}\b)/);
  if (eircode && isDublinAreaCode(eircode[1])) return eircode[1];

  // Restaurant sites commonly write this as either "Dublin 6" or
  // "Dublin, 6". Both are useful district-level fallbacks when a full
  // seven-character Eircode is not published.
  const district = address.match(/\bDUBLIN[\s,]*(\d{1,2}|6W)\b/i)?.[1]?.toUpperCase();
  if (!district) return null;
  const code = district === '6W' ? 'D6W' : `D${district.padStart(2, '0')}`;
  return isDublinAreaCode(code) ? code : null;
}

export function dublinAreaForAddress(address: string | null | undefined):
  | { code: DublinAreaCode; label: string; display: string }
  | null {
  const code = extractDublinAreaCode(address);
  if (!code) return null;
  return { code, ...DUBLIN_EIRCODE_AREAS[code] };
}
