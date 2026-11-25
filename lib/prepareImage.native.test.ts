import {
  deleteTempImages,
  prepareForRecognition,
  RECOGNITION_MAX_EDGE,
  RECOGNITION_UPSCALE,
  targetSize,
} from './prepareImage.native';

type FakeRef = { width: number; height: number; saveAsync: jest.Mock; release: jest.Mock };

const mockManipulate = jest.fn();
const mockFiles = new Map<string, { exists: boolean; delete: jest.Mock }>();

jest.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: (src: unknown) => mockManipulate(src) },
  SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
}));

jest.mock('expo-file-system', () => ({
  Paths: { cache: { uri: 'file:///app/Library/Caches/' } },
  File: jest.fn().mockImplementation((uri: string) => {
    const f = mockFiles.get(uri);
    if (!f) throw new Error('invalid path');
    return f;
  }),
}));

function fakeRef(width: number, height: number): FakeRef {
  return {
    width,
    height,
    saveAsync: jest.fn(async () => ({ uri: `file:///app/Library/Caches/ImageManipulator/${width}x${height}.jpg`, width, height })),
    release: jest.fn(),
  };
}

type FakeContext = { resize: jest.Mock; renderAsync: jest.Mock };

function fakeContext(rendered: FakeRef | Error): FakeContext {
  const ctx: FakeContext = {
    resize: jest.fn(() => ctx),
    renderAsync: jest.fn(async () => {
      if (rendered instanceof Error) throw rendered;
      return rendered;
    }),
  };
  return ctx;
}

beforeEach(() => {
  mockManipulate.mockReset();
  mockFiles.clear();
});

describe('targetSize', () => {
  it.each([
    [4032, 3024, 2048, 1536],
    [3024, 4032, 1536, 2048],
    [1000, 800, 1000, 800],
    [2048, 1000, 2048, 1000],
    [4000, 4000, 2048, 2048],
    [4033, 3023, 2048, 1535],
    [10000, 3, 2048, 1],
  ])('%i×%i → %i×%i', (w, h, ew, eh) => {
    expect(targetSize(w, h, RECOGNITION_MAX_EDGE)).toEqual({ width: ew, height: eh });
  });

  it('without an upscale option it never upscales and always returns integers', () => {
    for (const [w, h] of [[1, 1], [999.6, 10.2], [5000, 1234], [1234, 5000], [2049, 2047], [3000.5, 1999.5]] as const) {
      const out = targetSize(w, h, RECOGNITION_MAX_EDGE);
      expect(Number.isInteger(out.width) && Number.isInteger(out.height)).toBe(true);
      expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(Math.max(RECOGNITION_MAX_EDGE, Math.round(Math.max(w, h))));
      expect(out.width).toBeLessThanOrEqual(Math.max(1, Math.round(w)));
      expect(out.height).toBeLessThanOrEqual(Math.max(1, Math.round(h)));
    }
  });

  it('uses the measured upscale settings: below 1000 px → 1600 px long edge, within the 2048 cap', () => {
    expect(RECOGNITION_UPSCALE).toEqual({ belowEdge: 1000, toEdge: 1600 });
    expect(RECOGNITION_UPSCALE.toEdge).toBeLessThanOrEqual(RECOGNITION_MAX_EDGE);
  });

  it.each([
    // The low-resolution receipt that read as garbage (263×450).
    [263, 450, 935, 1600],
    [450, 263, 1600, 935],
    [999, 500, 1600, 801],
    [600, 600, 1600, 1600],
    [3, 999, 5, 1600],
    [1, 1, 1600, 1600],
    // At or above the minimum: unchanged, or downscaled exactly as before.
    [1000, 800, 1000, 800],
    [866, 1390, 866, 1390],
    [2048, 1000, 2048, 1000],
    [4032, 3024, 2048, 1536],
    [3072, 4080, 1542, 2048],
  ])('with RECOGNITION_UPSCALE: %i×%i → %i×%i', (w, h, ew, eh) => {
    expect(targetSize(w, h, RECOGNITION_MAX_EDGE, RECOGNITION_UPSCALE)).toEqual({ width: ew, height: eh });
  });

  it('upscaled sizes are integers, keep the aspect ratio and never exceed the cap', () => {
    for (const [w, h] of [[263, 450], [999.6, 10.2], [10.2, 999.6], [123.4, 567.8], [7, 3]] as const) {
      const out = targetSize(w, h, RECOGNITION_MAX_EDGE, RECOGNITION_UPSCALE);
      expect(Number.isInteger(out.width) && Number.isInteger(out.height)).toBe(true);
      expect(Math.max(out.width, out.height)).toBe(1600);
      // Rounding the short edge moves the ratio by at most half a pixel.
      const shortIn = Math.min(w, h) * (1600 / Math.max(w, h));
      expect(Math.abs(Math.min(out.width, out.height) - shortIn)).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(w >= h ? out.width >= out.height : out.height >= out.width).toBe(true);
    }
  });

  it('caps the upscale target at maxEdge and never shrinks an image while "upscaling"', () => {
    expect(targetSize(300, 400, 1200, { belowEdge: 1000, toEdge: 5000 })).toEqual({ width: 900, height: 1200 });
    // A target at or below the current size leaves the image alone.
    expect(targetSize(800, 400, 2048, { belowEdge: 1000, toEdge: 700 })).toEqual({ width: 800, height: 400 });
  });

  it.each([
    [{ belowEdge: 0, toEdge: 1600 }],
    [{ belowEdge: 1000, toEdge: NaN }],
    [{ belowEdge: Infinity, toEdge: 1600 }],
    [{ belowEdge: 1000, toEdge: -1 }],
  ])('rejects bad upscale options %p', (upscale) => {
    expect(() => targetSize(100, 100, RECOGNITION_MAX_EDGE, upscale)).toThrow(RangeError);
  });

  it.each([[0, 10], [10, -1], [NaN, 10], [10, Infinity]])('rejects %p×%p', (w, h) => {
    expect(() => targetSize(w, h, RECOGNITION_MAX_EDGE)).toThrow(RangeError);
  });
});

describe('prepareForRecognition', () => {
  it('resizes a large photo from the rendered image and saves JPEG at 0.9', async () => {
    const original = fakeRef(4032, 3024);
    const resized = fakeRef(2048, 1536);
    const first = fakeContext(original);
    const second = fakeContext(resized);
    mockManipulate.mockReturnValueOnce(first).mockReturnValueOnce(second);

    await expect(prepareForRecognition('file:///app/Library/Caches/ImagePicker/p.jpg')).resolves.toEqual({
      uri: 'file:///app/Library/Caches/ImageManipulator/2048x1536.jpg',
      width: 2048,
      height: 1536,
    });
    expect(mockManipulate).toHaveBeenNthCalledWith(1, 'file:///app/Library/Caches/ImagePicker/p.jpg');
    expect(mockManipulate).toHaveBeenNthCalledWith(2, original);
    expect(second.resize).toHaveBeenCalledWith({ width: 2048, height: 1536 });
    expect(resized.saveAsync).toHaveBeenCalledWith({ format: 'jpeg', compress: 0.9 });
    expect(original.saveAsync).not.toHaveBeenCalled();
    expect(original.release).toHaveBeenCalled();
    expect(resized.release).toHaveBeenCalled();
  });

  it('re-saves a mid-size photo without resizing (long edge between 1000 and 2048)', async () => {
    const original = fakeRef(1000, 800);
    mockManipulate.mockReturnValueOnce(fakeContext(original));
    await expect(prepareForRecognition('file:///app/Library/Caches/p.jpg')).resolves.toMatchObject({ width: 1000, height: 800 });
    expect(mockManipulate).toHaveBeenCalledTimes(1);
    expect(original.saveAsync).toHaveBeenCalledWith({ format: 'jpeg', compress: 0.9 });
  });

  it('upscales a low-resolution photo to 1600 px on the long edge, saves only the upscaled copy, frees both', async () => {
    const original = fakeRef(263, 450);
    const upscaled = fakeRef(935, 1600);
    const second = fakeContext(upscaled);
    mockManipulate.mockReturnValueOnce(fakeContext(original)).mockReturnValueOnce(second);
    await expect(prepareForRecognition('file:///app/Library/Caches/ImagePicker/small.jpg')).resolves.toEqual({
      uri: 'file:///app/Library/Caches/ImageManipulator/935x1600.jpg',
      width: 935,
      height: 1600,
    });
    expect(mockManipulate).toHaveBeenNthCalledWith(2, original);
    expect(second.resize).toHaveBeenCalledWith({ width: 935, height: 1600 });
    expect(upscaled.saveAsync).toHaveBeenCalledWith({ format: 'jpeg', compress: 0.9 });
    expect(original.saveAsync).not.toHaveBeenCalled();
    expect(original.release).toHaveBeenCalled();
    expect(upscaled.release).toHaveBeenCalled();
  });

  it('rejects with image_load_failed when the upscale render fails, and still frees the original', async () => {
    const original = fakeRef(263, 450);
    mockManipulate.mockReturnValueOnce(fakeContext(original)).mockReturnValueOnce(fakeContext(new Error('out of memory')));
    await expect(prepareForRecognition('file:///p.jpg')).rejects.toMatchObject({ code: 'image_load_failed' });
    expect(original.release).toHaveBeenCalled();
  });

  it('rejects with RecognitionError image_load_failed when the photo cannot be read', async () => {
    mockManipulate.mockReturnValueOnce(fakeContext(new Error('cannot decode /secret/path')));
    await expect(prepareForRecognition('file:///bad.jpg')).rejects.toMatchObject({
      name: 'RecognitionError',
      code: 'image_load_failed',
    });
  });

  it('rejects with image_load_failed when saving fails, and still releases native memory', async () => {
    const original = fakeRef(1000, 800);
    original.saveAsync.mockRejectedValueOnce(new Error('disk full'));
    mockManipulate.mockReturnValueOnce(fakeContext(original));
    await expect(prepareForRecognition('file:///p.jpg')).rejects.toMatchObject({ code: 'image_load_failed' });
    expect(original.release).toHaveBeenCalled();
  });
});

describe('deleteTempImages', () => {
  const inCache = (name: string) => `file:///app/Library/Caches/${name}`;

  function addFile(uri: string, exists = true) {
    const f = { exists, delete: jest.fn() };
    mockFiles.set(uri, f);
    return f;
  }

  it('deletes each cache file once, skipping blanks and duplicates', async () => {
    const a = addFile(inCache('ImagePicker/a.jpg'));
    const b = addFile(inCache('ImageManipulator/b.jpg'));
    await deleteTempImages([inCache('ImagePicker/a.jpg'), null, undefined, '', inCache('ImageManipulator/b.jpg'), inCache('ImagePicker/a.jpg')]);
    expect(a.delete).toHaveBeenCalledTimes(1);
    expect(b.delete).toHaveBeenCalledTimes(1);
  });

  it('never deletes outside the cache folder', async () => {
    const outside = addFile('file:///app/Documents/receipt.jpg');
    const escape = addFile(inCache('../Documents/receipt.jpg'));
    const lookalike = addFile('file:///app/Library/CachesEvil/x.jpg');
    await deleteTempImages(['file:///app/Documents/receipt.jpg', inCache('../Documents/receipt.jpg'), 'file:///app/Library/CachesEvil/x.jpg']);
    expect(outside.delete).not.toHaveBeenCalled();
    expect(escape.delete).not.toHaveBeenCalled();
    expect(lookalike.delete).not.toHaveBeenCalled();
  });

  it('skips missing files and never throws', async () => {
    const missing = addFile(inCache('gone.jpg'), false);
    const failing = addFile(inCache('locked.jpg'));
    failing.delete.mockImplementation(() => {
      throw new Error('EPERM');
    });
    const after = addFile(inCache('after.jpg'));
    await expect(
      deleteTempImages([inCache('gone.jpg'), inCache('locked.jpg'), inCache('not-a-known-file.jpg'), inCache('after.jpg')]),
    ).resolves.toBeUndefined();
    expect(missing.delete).not.toHaveBeenCalled();
    expect(after.delete).toHaveBeenCalledTimes(1);
  });
});
