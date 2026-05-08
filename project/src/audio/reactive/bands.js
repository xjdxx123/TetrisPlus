// Log-spaced frequency band integrator.
//
// Stage 5 of plan_particle_2.md. Linear FFT bins don't match human pitch
// perception — equal-width bins lump 200Hz–600Hz (musically a fifth) into
// the same window as 8kHz–8.4kHz (musically nothing). The fix is log-spaced
// bands; the canonical 6-band split (sub / bass / lowMid / mid / highMid /
// air) maps cleanly to "what part of the music" each band represents.

const DEFAULT_BAND_RANGES = Object.freeze([
  { name: 'sub',     loHz: 20,    hiHz: 60    },
  { name: 'bass',    loHz: 60,    hiHz: 200   },
  { name: 'lowMid',  loHz: 200,   hiHz: 500   },
  { name: 'mid',     loHz: 500,   hiHz: 2000  },
  { name: 'highMid', loHz: 2000,  hiHz: 6000  },
  { name: 'air',     loHz: 6000,  hiHz: 16000 },
]);

// Build per-band bin index arrays once; doing it per-frame would be a hot loop.
function indexBands(ranges, fftSize, sampleRate) {
  const binWidthHz = sampleRate / fftSize;
  return ranges.map(({ name, loHz, hiHz }) => {
    const lo = Math.max(0, Math.floor(loHz / binWidthHz));
    const hi = Math.max(lo + 1, Math.ceil(hiHz / binWidthHz));
    return { name, lo, hi, span: hi - lo };
  });
}

export function createBands({ ranges = DEFAULT_BAND_RANGES, fftSize, sampleRate } = {}) {
  let indexed = null;
  if (fftSize && sampleRate) indexed = indexBands(ranges, fftSize, sampleRate);

  // Most recent integrated value per band, in [0,1].
  const values = Object.create(null);
  for (const r of ranges) values[r.name] = 0;

  return {
    // Lazy index — called once when the analyser comes online.
    bind(fftSize_, sampleRate_) {
      indexed = indexBands(ranges, fftSize_, sampleRate_);
    },

    // Integrate the current FFT sample into per-band averages.
    integrate(binsNorm) {
      if (!indexed || !binsNorm) return values;
      for (const b of indexed) {
        let sum = 0;
        for (let i = b.lo; i < b.hi; i++) sum += binsNorm[i];
        values[b.name] = sum / b.span;
      }
      return values;
    },

    get values() { return values; },
    get isBound() { return !!indexed; },
    get bandNames() { return ranges.map(r => r.name); },
  };
}
