// Pipeline config (spec: docs/specs/2026-11-22-web-opencv-preprocessing.md, C3 "Config").
import {
  NO_WORD_DICTIONARIES,
  PIPELINE,
  PSM_SINGLE_COLUMN,
  TESSERACT_DPI,
  TESSERACT_INIT_ONLY_PARAMS,
  TESSERACT_READ_AT_INIT_PARAMS,
  TEXT_HEIGHT_TARGETS_PX,
  THRESHOLDING,
  usesCv,
  VARIANTS,
  WEB_CV_PREPROCESS,
  WEB_PLANS,
  checkPlan,
  resolvePlan,
} from './config';

describe('starting values keep today\'s behaviour', () => {
  it('ships web-current / native-current with no retry and OpenCV off', () => {
    expect(PIPELINE).toEqual({
      web: { primary: 'web-current', retry: null },
      native: { primary: 'native-current', retry: null },
    });
    expect(WEB_CV_PREPROCESS).toBe(false);
  });

  it.each(['web-current', 'native-current'])('%s has every new stage off', (name) => {
    expect(VARIANTS[name]?.config).toEqual({
      locate: false,
      crop: false,
      enhance: false,
      textHeightRescale: false,
      recognize: { tiling: false, zoomOnDoubt: false },
    });
  });

  it('every PIPELINE name exists for its platform', () => {
    expect(() => resolvePlan(PIPELINE.web, 'web')).not.toThrow();
    expect(() => resolvePlan(PIPELINE.native, 'native')).not.toThrow();
  });
});

describe('resolvePlan', () => {
  it('looks up primary and retry', () => {
    expect(resolvePlan({ primary: 'web-current', retry: 'web-current' }, 'web')).toEqual({
      primary: { variant: 'web-current', config: VARIANTS['web-current']?.config },
      retry: { variant: 'web-current', config: VARIANTS['web-current']?.config },
    });
  });

  it('refuses an unknown name and another platform\'s variant', () => {
    expect(() => resolvePlan({ primary: 'nope', retry: null }, 'web')).toThrow(RangeError);
    expect(() => resolvePlan({ primary: 'web-current', retry: 'native-current' }, 'web')).toThrow(RangeError);
  });
});

describe('Tesseract variants (spec Task 5)', () => {
  const tess = Object.entries(VARIANTS).filter(([k]) => k.startsWith('web-tess-'));

  it('web-current carries no Tesseract settings (today\'s engine settings apply)', () => {
    expect(VARIANTS['web-current']!.config.recognize.tesseract).toBeUndefined();
  });

  it('each is web-current plus Tesseract settings only, and never needs OpenCV', () => {
    expect(tess.length).toBeGreaterThanOrEqual(10);
    const base = VARIANTS['web-current']!.config;
    for (const [, v] of tess) {
      expect(v.platform).toBe('web');
      expect({ ...v.config, recognize: { ...v.config.recognize, tesseract: undefined } }).toEqual(base);
      expect(usesCv(v.config)).toBe(false);
    }
  });

  it('no variant sets an init-only parameter per read (it would silently do nothing)', () => {
    for (const [, v] of Object.entries(VARIANTS)) {
      const params = Object.keys(v.config.recognize.tesseract?.params ?? {});
      expect(params.filter((p) => TESSERACT_INIT_ONLY_PARAMS.includes(p))).toEqual([]);
    }
  });

  it('init holds only parameters read at init, and params none of those', () => {
    const atInit = [...TESSERACT_INIT_ONLY_PARAMS, ...TESSERACT_READ_AT_INIT_PARAMS];
    for (const [, v] of Object.entries(VARIANTS)) {
      for (const k of Object.keys(v.config.recognize.tesseract?.init ?? {})) expect(atInit).toContain(k);
      for (const k of Object.keys(v.config.recognize.tesseract?.params ?? {})) expect(atInit).not.toContain(k);
    }
  });

  it('the E1 crossing differs from web-tess-dpi300 by the thresholding method alone', () => {
    const dpi = VARIANTS['web-tess-dpi300']!.config.recognize.tesseract!.params;
    for (const name of ['web-tess-thresh1-dpi300', 'web-tess-thresh2-dpi300']) {
      const { thresholding_method: m, ...rest } = VARIANTS[name]!.config.recognize.tesseract!.params;
      expect(rest).toEqual(dpi);
      expect(['1', '2']).toContain(m);
    }
  });

  it('values are Tesseract strings: the DPI is a positive integer, thresholding 0/1/2, dictionaries "0"', () => {
    expect(TESSERACT_DPI).toMatch(/^[1-9]\d*$/);
    expect(Object.values(THRESHOLDING)).toEqual(['0', '1', '2']);
    expect(Object.values(NO_WORD_DICTIONARIES).every((v) => v === '0')).toBe(true);
    expect(VARIANTS['web-tess-rotate']!.config.recognize.tesseract!.rotateAuto).toBe(true);
  });
});

describe('PSM 4 after the crop (spec Task 7, criterion 41)', () => {
  it('is web-crop-canvas with page segmentation 4 for the read only (one factor)', () => {
    const v = VARIANTS['web-crop-canvas-psm4']!;
    expect(v.platform).toBe('web');
    expect(PSM_SINGLE_COLUMN).toBe('4');
    expect(v.config.recognize.tesseract).toEqual({ params: { tessedit_pageseg_mode: '4' } });
    expect({ ...v.config, recognize: { ...v.config.recognize, tesseract: undefined } }).toEqual({
      ...VARIANTS['web-crop-canvas']!.config,
      recognize: { ...VARIANTS['web-crop-canvas']!.config.recognize, tesseract: undefined },
    });
    expect(usesCv(v.config)).toBe(true);
  });

  it('production does not use it', () => {
    expect(PIPELINE.web.primary).not.toBe('web-crop-canvas-psm4');
    expect(PIPELINE.web.retry).not.toBe('web-crop-canvas-psm4');
  });
});

describe('text-height variants (spec Task 8, E2)', () => {
  const names = TEXT_HEIGHT_TARGETS_PX.map((t) => `web-crop-th${t}`);

  it('one per spec starting target (28, 34, 40, 46 px), with the ±15% band', () => {
    expect([...TEXT_HEIGHT_TARGETS_PX]).toEqual([28, 34, 40, 46]);
    for (const [i, name] of names.entries()) {
      const v = VARIANTS[name];
      expect(v?.platform).toBe('web');
      expect(v?.config.textHeightRescale).toEqual({ targetLineHeightPx: TEXT_HEIGHT_TARGETS_PX[i], band: [0.85, 1.15] });
    }
  });

  it('each is web-crop-canvas plus the second pass only (one factor), on the canvas resampler', () => {
    for (const name of names) {
      const c = VARIANTS[name]!.config;
      expect({ ...c, textHeightRescale: false }).toEqual(VARIANTS['web-crop-canvas']!.config);
      expect(c.normalize).toBeUndefined();
    }
  });

  it('production does not use them', () => {
    expect(names).not.toContain(PIPELINE.web.primary);
    expect(names).not.toContain(PIPELINE.web.retry);
    expect(VARIANTS[PIPELINE.web.primary]!.config.textHeightRescale).toBe(false);
  });
});

describe('switchable web plans (spec Task 11)', () => {
  const webVariants = Object.entries(VARIANTS)
    .filter(([, v]) => v.platform === 'web')
    .map(([k]) => k);

  it('PIPELINE.web.retry can name any web variant', () => {
    for (const name of webVariants) {
      const r = resolvePlan({ primary: 'web-current', retry: name }, 'web');
      expect(r.retry).toEqual({ variant: name, config: VARIANTS[name]!.config });
    }
  });

  it('production ships the "current" plan: web-current with no retry (Task 14 decides)', () => {
    expect(PIPELINE.web).toBe(WEB_PLANS.current);
    expect(WEB_PLANS.current).toEqual({ primary: 'web-current', retry: null });
  });

  it('lists Task 14\'s proposed plan (the crop alone, no retry); it needs OpenCV on', () => {
    expect(WEB_PLANS['crop-canvas']).toEqual({ primary: 'web-crop-canvas', retry: null });
    expect(checkPlan(WEB_PLANS['crop-canvas'], 'web', false)).toEqual(['primary_needs_cv']);
    expect(checkPlan(WEB_PLANS['crop-canvas'], 'web', true)).toEqual([]);
  });

  it('lists the measured retry pairs, both ways round', () => {
    expect(WEB_PLANS['current-then-crop-th40']).toEqual({ primary: 'web-current', retry: 'web-crop-th40' });
    expect(WEB_PLANS['crop-th40-then-current']).toEqual({ primary: 'web-crop-th40', retry: 'web-current' });
    expect(WEB_PLANS['current-then-crop-canvas']).toEqual({ primary: 'web-current', retry: 'web-crop-canvas' });
    expect(WEB_PLANS['crop-canvas-then-current']).toEqual({ primary: 'web-crop-canvas', retry: 'web-current' });
  });

  it('every listed plan is valid once OpenCV is on', () => {
    for (const [name, plan] of Object.entries(WEB_PLANS)) expect({ name, problems: checkPlan(plan, 'web', true) }).toEqual({ name, problems: [] });
  });

  it('the shipped plans are consistent with the master switch (switching to a cv plan needs WEB_CV_PREPROCESS = true)', () => {
    expect(checkPlan(PIPELINE.web, 'web', WEB_CV_PREPROCESS)).toEqual([]);
    expect(checkPlan(PIPELINE.native, 'native', WEB_CV_PREPROCESS)).toEqual([]);
  });

  describe('checkPlan', () => {
    it('a cv variant in either slot with OpenCV off is needs_cv (it would silently run without the cv steps)', () => {
      expect(checkPlan({ primary: 'web-current', retry: 'web-crop-th40' }, 'web', false)).toEqual(['retry_needs_cv']);
      expect(checkPlan({ primary: 'web-crop-th40', retry: 'web-current' }, 'web', false)).toEqual(['primary_needs_cv']);
      expect(checkPlan({ primary: 'web-crop-th40', retry: 'web-crop-canvas' }, 'web', false)).toEqual(['primary_needs_cv', 'retry_needs_cv']);
    });

    it('a non-cv retry with OpenCV off is fine', () => {
      expect(checkPlan({ primary: 'web-current', retry: 'web-tess-rotate' }, 'web', false)).toEqual([]);
    });

    it('a retry identical to the primary is retry_same (the same read twice only costs time)', () => {
      expect(checkPlan({ primary: 'web-current', retry: 'web-current' }, 'web', false)).toEqual(['retry_same']);
      expect(checkPlan({ primary: 'web-crop-th40', retry: 'web-crop-th40' }, 'web', true)).toEqual(['retry_same']);
    });

    it('an unknown or other-platform variant is unknown_variant, not a throw', () => {
      expect(checkPlan({ primary: 'nope', retry: null }, 'web', true)).toEqual(['unknown_variant']);
      expect(checkPlan({ primary: 'web-current', retry: 'native-current' }, 'web', true)).toEqual(['unknown_variant']);
    });

    it('native ignores the web master switch', () => {
      expect(checkPlan({ primary: 'native-current', retry: null }, 'native', false)).toEqual([]);
    });
  });
});
