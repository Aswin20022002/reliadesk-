// Reference bearing physics from the real NASA IMS test rig.
// Geometry of the Rexnord ZA-2115 double-row bearing as published in Qiu, Lee, Lin and Yu (2006),
// "Wavelet filter-based weak signature detection method and its application on rolling element
// bearing prognostics", Journal of Sound and Vibration 289. Defect frequencies are computed here
// from that geometry with the standard kinematic formulas, not typed in.
// A plant asset's own bearing geometry must come from its CMMS or OEM data sheet.

const REF = { rollers: 16, rollerDiameterIn: 0.331, pitchDiameterIn: 2.815, contactAngleDeg: 15.17, rpm: 2000 }

export function referenceDefectFrequencies(rpm = REF.rpm) {
  const f = rpm / 60
  const k = (REF.rollerDiameterIn / REF.pitchDiameterIn) * Math.cos((REF.contactAngleDeg * Math.PI) / 180)
  const r = (x: number) => +x.toFixed(1)
  return {
    reference: 'Rexnord ZA-2115 on the NASA IMS rig (geometry from Qiu et al. 2006)',
    shaftRpm: rpm,
    shaftHz: r(f),
    outerRaceHz: r((REF.rollers / 2) * f * (1 - k)),
    innerRaceHz: r((REF.rollers / 2) * f * (1 + k)),
    rollerSpinHz: r((REF.pitchDiameterIn / (2 * REF.rollerDiameterIn)) * f * (1 - k * k)),
    cageHz: r((f / 2) * (1 - k)),
    note: 'If an envelope spectrum shows a peak and its harmonics at one of these frequencies, that points to the matching defect. Only valid for this bearing geometry and speed.',
  }
}
