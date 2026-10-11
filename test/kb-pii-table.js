'use strict';

// Frozen table of note texts for the KB PII scan (synthetic data only).
module.exports = Object.freeze({
  clean: Object.freeze([
    'S01（2026-10-09）の回答',
    'S12#C14 2026-10-09',
    '2026-10-09 - 2026-10-12',
    'S01#E11（2026-10-09）, S02（2026-10-10）',
    'sources S07#L11 and S03#C14',
    'verified 2026-10-12',
  ]),
  phones: Object.freeze([
    '03-1234-5678',
    '０９０－１２３４－５６７８',
    '+81 (90) 1234-5678',
    '09012345678',
    '電話03-1234-5678',
    'TEL03-1234-5678',
    '0466-12-3456',
    '電話0466-12-3456',
    'S01 0466-12-3456',
    'S01#C1（電話090-1234-5678）',
    'S01#tel:09012345678',
    'S01 TEL 03-1234-5678',
  ]),
});
